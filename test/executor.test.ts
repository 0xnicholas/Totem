import { describe, expect, it } from 'vitest';
import { ActionError, type TokenProvider } from '../src/index.js';
import type { CreateDocOutput } from '../src/index.js';
import {
  CONN_1,
  CONN_1_A,
  FAKE_CONNECTOR_ID,
  TENANT_A,
  TENANT_B,
  makeConnector,
  makeExecutor,
  makeHarness,
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
  });

  it('dispatches to the connector with the validated arguments (Seam A round trip)', async () => {
    const executor = makeExecutor();
    const created = await executor.executeAction(TENANT_A, CONN_1, 'create_doc', {
      title: 'Q3 planning',
      content: 'Draft outline',
    });
    if (!created.ok) return;
    const { doc_id } = created.output as CreateDocOutput;

    const read = await executor.executeAction(TENANT_A, CONN_1, 'get_doc_content', { doc_id });
    expect(read).toMatchObject({
      ok: true,
      output: { doc_id, content: 'Draft outline' },
    });

    const searched = await executor.executeAction(TENANT_A, CONN_1, 'search_docs', {
      query: 'Q3',
      limit: 10,
    });
    expect(searched).toMatchObject({ ok: true });
    if (searched.ok) {
      expect(searched.output).toMatchObject({ data: [{ doc_id, title: 'Q3 planning' }], next: null });
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
      const result = await executor.executeAction(TENANT_A, CONN_1, 'search_docs', {
        query: 'q',
        limit: 0,
      });

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

      const result = await executor.executeAction(TENANT_A, CONN_1, 'get_doc_content', {
        doc_id: 'doc_x',
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('action_not_found');
      expect(result.error.message).toBe(
        'Action "get_doc_content" is not available on connection "conn-1"',
      );
    });

    it('passes through a connector-emitted not_found error, with the cause in the message', async () => {
      const executor = makeExecutor();
      const result = await executor.executeAction(TENANT_A, CONN_1, 'get_doc_content', {
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
  it('getConnection enforces tenant isolation', async () => {
    const executor = makeExecutor();
    await expect(executor.getConnection(TENANT_A, CONN_1)).resolves.toMatchObject({
      tenantId: TENANT_A,
    });
    await expect(executor.getConnection(TENANT_B, CONN_1)).resolves.toBeUndefined();
    await expect(executor.getConnection(TENANT_A, 'conn-nope')).resolves.toBeUndefined();
  });

  it('getConnector returns the connection\'s registered connector', () => {
    const executor = makeExecutor();
    expect(executor.getConnector(FAKE_CONNECTOR_ID)?.manifest.id).toBe(FAKE_CONNECTOR_ID);
    expect(executor.getConnector('no-such-connector')).toBeUndefined();
  });
});

describe('token acquisition at the execution boundary (T6, ADR-0004)', () => {
  let handlerRan: boolean;
  let capturedToken: string | undefined;

  // Connector that captures the context token it received.
  const captureConnector = makeConnector('capture', ['create_doc'], {
    create_doc: (_args, ctx) => {
      handlerRan = true;
      capturedToken = ctx.token;
      return { doc_id: 'doc-1', title: 'captured' };
    },
  });

  function captureHarness(provider: TokenProvider | undefined) {
    handlerRan = false;
    capturedToken = undefined;
    return makeHarness({
      connectors: [captureConnector],
      connections: [{ ...CONN_1_A, connectorId: 'capture' }],
      tokenProvider: provider,
    });
  }

  it('places the provider token in ActionContext before dispatch', async () => {
    const provider: TokenProvider = {
      getValidAccessToken: () => Promise.resolve('tok-123'),
    };
    const { executor, audit } = captureHarness(provider);

    const result = await executor.executeAction(TENANT_A, CONN_1, 'create_doc', { title: 'x' });
    expect(result).toMatchObject({ ok: true });
    expect(capturedToken).toBe('tok-123');
    expect(audit.list()[0]).toMatchObject({ success: true, errorCode: null });
  });

  it('records the calling surface as the audit source', async () => {
    const { executor, audit } = captureHarness(undefined);
    await executor.executeAction(TENANT_A, CONN_1, 'create_doc', { title: 'x' }, 'rpc');
    expect(audit.list()[0]).toMatchObject({
      actionName: 'create_doc',
      success: true,
      source: 'rpc',
    });
  });

  it('maps provider auth_expired to a vocabulary error, audited, handler never runs', async () => {
    const provider: TokenProvider = {
      getValidAccessToken: () =>
        Promise.reject(new ActionError('auth_expired', 'refresh token rejected')),
    };
    const { executor, audit } = captureHarness(provider);

    const result = await executor.executeAction(TENANT_A, CONN_1, 'create_doc', { title: 'x' });
    expect(result).toMatchObject({ ok: false, error: { code: 'auth_expired', retryable: false } });
    expect(handlerRan).toBe(false);
    expect(audit.list()[0]).toMatchObject({
      actionName: 'create_doc',
      success: false,
      errorCode: 'auth_expired',
      source: 'mcp',
    });
  });

  it('wraps a non-vocabulary provider failure as upstream_error', async () => {
    const provider: TokenProvider = {
      getValidAccessToken: () => Promise.reject(new Error('token store exploded')),
    };
    const { executor, audit } = captureHarness(provider);

    const result = await executor.executeAction(TENANT_A, CONN_1, 'create_doc', { title: 'x' });
    expect(result).toMatchObject({ ok: false, error: { code: 'upstream_error' } });
    expect(handlerRan).toBe(false);
    expect(audit.list()[0]).toMatchObject({ success: false, errorCode: 'upstream_error' });
  });

  it('without a provider the context carries no token (T1 behavior preserved)', async () => {
    const { executor } = captureHarness(undefined);

    const result = await executor.executeAction(TENANT_A, CONN_1, 'create_doc', { title: 'x' });
    expect(result).toMatchObject({ ok: true });
    expect(handlerRan).toBe(true);
    expect(capturedToken).toBeUndefined();
  });
});

describe('test_connection (T10)', () => {
  it('executes through Seam A like any action, with allowlist + audit', async () => {
    const { executor, allowlists, audit } = makeHarness();

    const ok = await executor.executeAction(TENANT_A, CONN_1, 'test_connection', {});
    expect(ok).toMatchObject({ ok: true, output: { connection_id: CONN_1, status: 'ok' } });
    expect(audit.list()[0]).toMatchObject({
      actionName: 'test_connection',
      success: true,
      errorCode: null,
    });

    // An allowlist without test_connection denies it fail-closed, like any
    // other action.
    allowlists.setAllowed(TENANT_A, CONN_1, ['get_doc_content']);
    const denied = await executor.executeAction(TENANT_A, CONN_1, 'test_connection', {});
    expect(denied).toMatchObject({ ok: false, error: { code: 'forbidden' } });
  });

  it('rejects extra arguments (empty input schema)', async () => {
    const { executor } = makeHarness();
    const result = await executor.executeAction(TENANT_A, CONN_1, 'test_connection', {
      doc_id: 'doc-1',
    });
    expect(result).toMatchObject({ ok: false, error: { code: 'validation_error' } });
  });
});

describe('audit policy at the execution boundary (T11)', () => {
  function policyHarness(errorOnly: boolean) {
    return makeHarness({
      // eslint-disable-next-line @typescript-eslint/require-await -- synchronous test double
      auditPolicy: { getPolicy: async () => ({ errorOnly }) },
    });
  }

  it('error-only tenants skip success rows and keep failure rows', async () => {
    const { executor, allowlists, audit } = policyHarness(true);

    const ok = await executor.executeAction(TENANT_A, CONN_1, 'create_doc', { title: 'quiet' });
    expect(ok).toMatchObject({ ok: true });
    expect(audit.list()).toHaveLength(0);

    // Failures are always recorded — the trail answers "what failed, when".
    allowlists.setAllowed(TENANT_A, CONN_1, ['get_doc_content', 'create_doc']);
    const denied = await executor.executeAction(TENANT_A, CONN_1, 'get_doc_metadata', {
      doc_id: 'x',
    });
    expect(denied).toMatchObject({ ok: false, error: { code: 'forbidden' } });
    const failed = await executor.executeAction(TENANT_A, CONN_1, 'create_doc', {});
    expect(failed).toMatchObject({ ok: false, error: { code: 'validation_error' } });

    const rows = audit.list();
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.errorCode).sort()).toEqual(['forbidden', 'validation_error']);
  });

  it('without a provider every attempt is recorded (v1 default)', async () => {
    const { executor, audit } = makeHarness();
    await executor.executeAction(TENANT_A, CONN_1, 'create_doc', { title: 'loud' });
    expect(audit.list()).toHaveLength(1);
  });

  it('a failing policy lookup keeps recording (the trail never silently shrinks)', async () => {
    const { executor, audit } = makeHarness({
      auditPolicy: {
        // eslint-disable-next-line @typescript-eslint/require-await -- synchronous test double
        getPolicy: async () => {
          throw new Error('policy store exploded');
        },
      },
    });
    const ok = await executor.executeAction(TENANT_A, CONN_1, 'create_doc', { title: 'safe' });
    expect(ok).toMatchObject({ ok: true });
    expect(audit.list()).toHaveLength(1);
  });
});
