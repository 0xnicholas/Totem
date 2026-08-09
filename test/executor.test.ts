import { describe, expect, it } from 'vitest';
import type { CreateDocOutput } from '../src/index.js';
import {
  CONN_1,
  CONN_1_A,
  FAKE_CONNECTOR_ID,
  TENANT_A,
  TENANT_B,
  makeConnector,
  makeExecutor,
  makeMisbehavingExecutor,
} from './fixtures.js';

describe('executeAction (Seam A)', () => {
  it('executes a registered action and returns its output', async () => {
    const executor = makeExecutor();
    const created = await executor.executeAction(TENANT_A, CONN_1, 'create_doc', {
      title: 'Q3 planning',
      content: 'Draft outline',
    });

    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const output = created.output as CreateDocOutput;
    expect(output.title).toBe('Q3 planning');
    expect(output.doc_id).toMatch(/^doc_/);
    expect(output.url).toContain(output.doc_id);
  });

  it('dispatches to the connector with the validated arguments (Seam A round trip)', async () => {
    const executor = makeExecutor();
    const created = await executor.executeAction(TENANT_A, CONN_1, 'create_doc', {
      title: 'Q3 planning',
      content: 'Draft outline',
    });
    if (!created.ok) return;
    const { doc_id } = created.output as CreateDocOutput;

    const read = await executor.executeAction(TENANT_A, CONN_1, 'read_doc', { doc_id });
    expect(read).toMatchObject({
      ok: true,
      output: { doc_id, title: 'Q3 planning', content: 'Draft outline' },
    });

    const listed = await executor.executeAction(TENANT_A, CONN_1, 'list_docs', { limit: 10 });
    expect(listed).toMatchObject({ ok: true });
    if (listed.ok) {
      expect(listed.output).toMatchObject({ docs: [{ doc_id, title: 'Q3 planning' }] });
    }
  });

  it('accepts optional input properties', async () => {
    const executor = makeExecutor();
    const result = await executor.executeAction(TENANT_A, CONN_1, 'create_doc', {
      title: 'Draft',
      folder_id: 'folder-1',
    });
    expect(result).toMatchObject({ ok: true });
  });

  describe('error codes (ADR-0005 vocabulary)', () => {
    it('returns action_not_found for an unknown action name', async () => {
      const executor = makeExecutor();
      const result = await executor.executeAction(TENANT_A, CONN_1, 'frobnicate_doc', {});

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('action_not_found');
      expect(result.error.message).toBe('Unknown action "frobnicate_doc"');
      expect(result.error.retryable).toBe(false);
    });

    it('returns not_found for an unknown connection', async () => {
      const executor = makeExecutor();
      const result = await executor.executeAction(TENANT_A, 'conn-nope', 'create_doc', {
        title: 'x',
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('not_found');
      expect(result.error.message).toBe('Unknown connection "conn-nope" for tenant "tenant-a"');
    });

    it('returns not_found for an unknown tenant (tenant isolation)', async () => {
      const executor = makeExecutor();
      const result = await executor.executeAction(TENANT_B, CONN_1, 'create_doc', { title: 'x' });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('not_found');
    });

    it('returns validation_error with structured issues for a missing required property', async () => {
      const executor = makeExecutor();
      const result = await executor.executeAction(TENANT_A, CONN_1, 'create_doc', {});

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('validation_error');
      expect(result.error.message).toBe('Invalid arguments for action "create_doc"');
      expect(result.error.retryable).toBe(false);
      expect(result.error.details).toEqual([
        { path: '/title', keyword: 'required', message: "must have required property 'title'" },
      ]);
    });

    it('returns validation_error with structured issues for a wrong property type', async () => {
      const executor = makeExecutor();
      const result = await executor.executeAction(TENANT_A, CONN_1, 'create_doc', { title: 42 });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.details).toEqual([
        { path: '/title', keyword: 'type', message: 'must be string' },
      ]);
    });

    it('returns validation_error for an unexpected property', async () => {
      const executor = makeExecutor();
      const result = await executor.executeAction(TENANT_A, CONN_1, 'create_doc', {
        title: 'x',
        bogus: 1,
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.details).toEqual([
        { path: '/bogus', keyword: 'additionalProperties', message: 'must NOT have additional properties' },
      ]);
    });

    it('returns validation_error for out-of-range numeric properties', async () => {
      const executor = makeExecutor();
      const result = await executor.executeAction(TENANT_A, CONN_1, 'list_docs', { limit: 0 });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.details).toEqual([
        { path: '/limit', keyword: 'minimum', message: 'must be >= 1' },
      ]);
    });

    it('returns all validation issues at once (allErrors)', async () => {
      const executor = makeExecutor();
      const result = await executor.executeAction(TENANT_A, CONN_1, 'create_doc', {
        title: 42,
        bogus: 1,
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      const paths = (result.error.details as Array<{ path: string }>).map((d) => d.path).sort();
      expect(paths).toEqual(['/bogus', '/title']);
    });

    it('returns action_not_found when the connection connector does not implement the action', async () => {
      const partial = makeConnector('partial', ['create_doc'], {});
      const executor = makeExecutor({
        connectors: [partial],
        connections: [{ ...CONN_1_A, connectorId: 'partial' }],
      });

      const result = await executor.executeAction(TENANT_A, CONN_1, 'read_doc', {
        doc_id: 'doc_x',
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('action_not_found');
      expect(result.error.message).toBe('Action "read_doc" is not available on connection "conn-1"');
    });

    it('passes through a connector-emitted not_found error, with the cause in the message', async () => {
      const executor = makeExecutor();
      const result = await executor.executeAction(TENANT_A, CONN_1, 'read_doc', {
        doc_id: 'doc_nope',
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('not_found');
      expect(result.error.retryable).toBe(false);
      expect(result.error.message).toBe('Document "doc_nope" not found');
    });

    it('wraps a handler that throws a plain error as upstream_error with diagnostics', async () => {
      const executor = makeMisbehavingExecutor();
      const result = await executor.executeAction(TENANT_A, CONN_1, 'throw_noise', {});

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('upstream_error');
      expect(result.error.retryable).toBe(false);
      expect(result.error.message).toBe('Action "throw_noise" failed: connector exploded');
      expect(result.error.upstream).toEqual({ code: 'unknown', message: 'connector exploded' });
    });

    it('rejects handler output outside the platform vocabulary as upstream_error', async () => {
      const executor = makeMisbehavingExecutor();
      const result = await executor.executeAction(TENANT_A, CONN_1, 'malfunction_output', {
        why: 'test',
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('upstream_error');
      expect(result.error.message).toBe('Invalid output from action "malfunction_output"');
      expect(result.error.details).toEqual([
        { path: '/ok', keyword: 'type', message: 'must be boolean' },
      ]);
    });
  });
});

describe('read-only lookups for transport adapters (T5)', () => {
  it('getConnection enforces tenant isolation', () => {
    const executor = makeExecutor();
    expect(executor.getConnection(TENANT_A, CONN_1)).toMatchObject({ tenantId: TENANT_A });
    expect(executor.getConnection(TENANT_B, CONN_1)).toBeUndefined();
    expect(executor.getConnection(TENANT_A, 'conn-nope')).toBeUndefined();
  });

  it('getConnector returns the connection\'s registered connector', () => {
    const executor = makeExecutor();
    expect(executor.getConnector(FAKE_CONNECTOR_ID)?.manifest.id).toBe(FAKE_CONNECTOR_ID);
    expect(executor.getConnector('no-such-connector')).toBeUndefined();
  });
});
