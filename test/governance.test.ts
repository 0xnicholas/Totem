import { describe, expect, it } from 'vitest';
import type { ActionHandler, ConnectionRecord, IConnector } from '../src/index.js';
import { auditParamHash } from '../src/audit.js';
import type { AuditSink } from '../src/governance.js';
import { CONN_1, TENANT_A, TENANT_B, makeHarness } from './fixtures.js';

const RECORDING_CONNECTOR_ID = 'recording';

function recordingConnection(tenantId: string, connectionId: string): ConnectionRecord {
  return { tenantId, connectionId, connectorId: RECORDING_CONNECTOR_ID };
}

/** A connector whose handlers record invocations and return valid output. */
function makeRecordingConnector(calls: string[]): IConnector {
  const createDocHandler: ActionHandler = (args) => {
    calls.push('create_doc');
    const title = (args as { title: string }).title;
    return { doc_id: 'doc_1', title };
  };
  return {
    manifest: { id: RECORDING_CONNECTOR_ID, provider: 'feishu', implements: ['create_doc'] },
    execute: (action, args, ctx) => Promise.resolve(createDocHandler(args, ctx)),
  };
}

/** Audit sink that always throws, to prove audit writes are best effort. */
const failingAudit: AuditSink = {
  writeAudit: () => {
    throw new Error('audit db down');
  },
};

describe('governance at Seam A (allowlist + audit)', () => {
  it('executes an allowed action and audits the success', async () => {
    const { executor, audit } = makeHarness();
    const args = { title: 'Q3 planning', content: 'Draft' };

    const result = await executor.executeAction(TENANT_A, CONN_1, 'create_doc', args);

    expect(result).toMatchObject({ ok: true });
    expect(audit.list()).toHaveLength(1);
    const row = audit.list()[0]!;
    expect(row).toMatchObject({
      tenantId: TENANT_A,
      connectionId: CONN_1,
      actionName: 'create_doc',
      source: 'mcp',
      success: true,
      errorCode: null,
      userId: null,
    });
    expect(row.paramHash).toBe(auditParamHash(args));
    expect(row.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('rejects a disallowed action with forbidden and never reaches the handler', async () => {
    const calls: string[] = [];
    const { executor, audit, allowlists } = makeHarness({
      connectors: [makeRecordingConnector(calls)],
      connections: [recordingConnection(TENANT_A, CONN_1)],
    });
    allowlists.setAllowed(TENANT_A, CONN_1, ['search_docs']);

    const result = await executor.executeAction(TENANT_A, CONN_1, 'create_doc', { title: 'x' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('forbidden');
    expect(result.error.retryable).toBe(false);
    expect(result.error.message).toBe('Action "create_doc" is not allowed on connection "conn-1"');
    expect(calls).toEqual([]);

    const row = audit.list()[0]!;
    expect(row).toMatchObject({ actionName: 'create_doc', success: false, errorCode: 'forbidden' });
  });

  it('looks up the allowlist per (tenant, connection)', async () => {
    const calls: string[] = [];
    const { executor, allowlists } = makeHarness({
      connectors: [makeRecordingConnector(calls)],
      connections: [
        recordingConnection(TENANT_A, CONN_1),
        recordingConnection(TENANT_B, CONN_1),
        recordingConnection(TENANT_A, 'conn-other'),
      ],
    });
    allowlists.setAllowed(TENANT_A, CONN_1, ['create_doc']);
    allowlists.setAllowed(TENANT_B, CONN_1, []);
    allowlists.setAllowed(TENANT_A, 'conn-other', []);

    await expect(
      executor.executeAction(TENANT_A, CONN_1, 'create_doc', { title: 'x' }),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      executor.executeAction(TENANT_B, CONN_1, 'create_doc', { title: 'x' }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'forbidden' } });
    await expect(
      executor.executeAction(TENANT_A, 'conn-other', 'create_doc', { title: 'x' }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'forbidden' } });
    // Only the allowed attempt reached the handler.
    expect(calls).toHaveLength(1);
  });

  it('audits an unknown action', async () => {
    const { executor, audit } = makeHarness();
    const result = await executor.executeAction(TENANT_A, CONN_1, 'frobnicate_doc', {});

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('action_not_found');
    expect(audit.list()).toHaveLength(1);
    expect(audit.list()[0]).toMatchObject({
      actionName: 'frobnicate_doc',
      success: false,
      errorCode: 'action_not_found',
    });
  });

  it('audits a validation failure with the received args hash', async () => {
    const { executor, audit } = makeHarness();
    const badArgs = { title: 42 };
    const result = await executor.executeAction(TENANT_A, CONN_1, 'create_doc', badArgs);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('validation_error');
    const row = audit.list()[0]!;
    expect(row).toMatchObject({
      actionName: 'create_doc',
      success: false,
      errorCode: 'validation_error',
    });
    expect(row.paramHash).toBe(auditParamHash(badArgs));
  });

  it('audits a handler failure with the mapped error code', async () => {
    const { executor, audit } = makeHarness();
    const result = await executor.executeAction(TENANT_A, CONN_1, 'get_doc_content', {
      doc_id: 'nope',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('not_found');
    expect(audit.list()[0]).toMatchObject({
      actionName: 'get_doc_content',
      success: false,
      errorCode: 'not_found',
    });
  });

  it('writes one audit row per attempt across mixed outcomes', async () => {
    const { executor, audit } = makeHarness();
    await executor.executeAction(TENANT_A, CONN_1, 'create_doc', { title: 'a' });
    await executor.executeAction(TENANT_A, CONN_1, 'create_doc', { title: 'b' });
    await executor.executeAction(TENANT_A, CONN_1, 'create_doc', {});
    await executor.executeAction(TENANT_A, CONN_1, 'frobnicate_doc', {});

    const rows = audit.list();
    expect(rows).toHaveLength(4);
    expect(rows.map((r) => r.actionName)).toEqual([
      'create_doc',
      'create_doc',
      'create_doc',
      'frobnicate_doc',
    ]);
    expect(rows.map((r) => r.errorCode)).toEqual([
      null,
      null,
      'validation_error',
      'action_not_found',
    ]);
    expect(rows.every((r) => r.source === 'mcp' && r.userId === null)).toBe(true);
  });

  it('keeps the action result even when the audit write fails (best effort)', async () => {
    const { executor } = makeHarness({ audit: failingAudit });

    const result = await executor.executeAction(TENANT_A, CONN_1, 'create_doc', { title: 'x' });

    expect(result).toMatchObject({ ok: true });
  });
});
