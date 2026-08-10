import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { serve, type ServerType } from '@hono/node-server';
import type { AddressInfo } from 'node:net';
import type { Action } from '../src/action.js';
import { createRpcApp } from '../src/rest/rpc.js';
import { FakeConnector } from '../src/testing/fake-connector.js';
import { InMemoryMCPKeyStore } from '../src/testing/memory-key-store.js';
import { CONN_1, TENANT_A, makeConnector, makeHarness } from './fixtures.js';

const RPC_KEY = 'tt_dev_rpc_test_key';

/**
 * The REST Actions RPC surface (T14, ADR-0008): `POST /actions/rpc` is the
 * non-agent consumption floor — CI, scheduled jobs, backend services. It is
 * a pure projection of `executeAction` (Seam A): same governance, same
 * audit, same ADR-0005 error vocabulary, mapped to HTTP status. The
 * envelope is `{action, args}` — the same flat args object MCP `tools/call`
 * receives, so the two surfaces can never diverge in parameter shape.
 *
 * Transport-level failures (auth, missing connection header, malformed
 * body) are plain `{error}` 4xx responses; action-level failures are
 * ActionErrorJson bodies with status per the mapping table.
 */
describe('REST Actions RPC (T14, HTTP boundary)', () => {
  let server: ServerType;
  let baseUrl: string;
  let harness: ReturnType<typeof makeHarness>;

  beforeAll(async () => {
    harness = makeHarness();
    const keys = new InMemoryMCPKeyStore();
    keys.addKey(RPC_KEY, TENANT_A);
    keys.addKey('tt_dev_rpc_admin', TENANT_A, { scope: 'admin' });
    keys.addKey('tt_dev_rpc_disabled', TENANT_A, { disabled: true });
    const app = createRpcApp({ executor: harness.executor, keys });
    server = serve({ fetch: app.fetch, port: 0 });
    await new Promise((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  function rpcCall(
    body: unknown,
    init: { headers?: Record<string, string>; key?: string; connection?: string } = {},
  ): Promise<Response> {
    return fetch(`${baseUrl}/actions/rpc`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${init.key ?? RPC_KEY}`,
        'x-connection-id': init.connection ?? CONN_1,
        ...init.headers,
      },
      body: JSON.stringify(body),
    });
  }

  it('rejects missing, invalid, admin-scoped and disabled keys with 401', async () => {
    expect((await fetch(`${baseUrl}/actions/rpc`, { method: 'POST' })).status).toBe(401);
    expect(
      (
        await fetch(`${baseUrl}/actions/rpc`, {
          method: 'POST',
          headers: { authorization: 'Bearer nope' },
        })
      ).status,
    ).toBe(401);
    for (const key of ['tt_dev_rpc_admin', 'tt_dev_rpc_disabled']) {
      const response = await rpcCall({ action: 'create_doc' }, { key });
      expect(response.status).toBe(401);
    }
  });

  it('rejects requests without an x-connection-id header with 400', async () => {
    const response = await fetch(`${baseUrl}/actions/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${RPC_KEY}` },
      body: JSON.stringify({ action: 'create_doc' }),
    });
    expect(response.status).toBe(400);
    const payload = (await response.json()) as { error: string };
    expect(payload.error).toContain('x-connection-id');
  });

  it('rejects malformed envelopes with 400 before any action logic', async () => {
    const malformed = [
      'not json',
      JSON.stringify({}),
      JSON.stringify({ args: {} }),
      JSON.stringify({ action: 5 }),
      JSON.stringify({ action: 'create_doc', args: 'nope' }),
    ];
    for (const body of malformed) {
      const response = await rpcCall(body);
      expect(response.status).toBe(400);
      const payload = (await response.json()) as { error: string };
      expect(payload.error).toBeTruthy();
    }
  });

  it('executes an allowed action and returns the unified output (200)', async () => {
    const response = await rpcCall({
      action: 'create_doc',
      args: { title: 'Q3 planning', content: 'Draft outline' },
    });
    expect(response.status).toBe(200);
    const payload = (await response.json()) as { doc_id: string; title: string };
    expect(payload.doc_id).toMatch(/^doc_/);
    expect(payload.title).toBe('Q3 planning');
  });

  it('defaults missing args to an empty object', async () => {
    const response = await rpcCall({ action: 'test_connection' });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'ok' });
  });

  it('maps validation failures to 400 with the ADR-0005 body', async () => {
    const response = await rpcCall({ action: 'create_doc', args: {} });
    expect(response.status).toBe(400);
    const payload = (await response.json()) as { code: string; retryable: boolean };
    expect(payload.code).toBe('validation_error');
    expect(payload.retryable).toBe(false);
  });

  it('maps unknown actions and unknown connections to 404', async () => {
    const unknownAction = await rpcCall({ action: 'no_such_action' });
    expect(unknownAction.status).toBe(404);
    expect(((await unknownAction.json()) as { code: string }).code).toBe('action_not_found');

    const unknownConnection = await rpcCall(
      { action: 'create_doc', args: { title: 't' } },
      { connection: 'conn-nope' },
    );
    expect(unknownConnection.status).toBe(404);
    expect(((await unknownConnection.json()) as { code: string }).code).toBe('not_found');
  });

  it('maps allowlist rejections to 403 with the ADR-0005 body', async () => {
    // Narrow the allowlist to search_docs only: create_doc becomes forbidden.
    harness.allowlists.setAllowed(TENANT_A, CONN_1, ['search_docs']);
    const response = await rpcCall({ action: 'create_doc', args: { title: 't' } });
    expect(response.status).toBe(403);
    expect(((await response.json()) as { code: string }).code).toBe('forbidden');
  });

  it('maps a throttled call to 429 with Retry-After (T13 contract)', async () => {
    const limiterHarness = makeHarness({
      connectors: [new FakeConnector([], { rateLimit: { requestsPerMinute: 1 } })],
    });
    const keys = new InMemoryMCPKeyStore();
    keys.addKey(RPC_KEY, TENANT_A);
    const app = createRpcApp({ executor: limiterHarness.executor, keys });
    const limitedServer = serve({ fetch: app.fetch, port: 0 });
    await new Promise((resolve) => limitedServer.once('listening', resolve));
    const limitedBase = `http://127.0.0.1:${(limitedServer.address() as AddressInfo).port}`;
    try {
      const call = () =>
        fetch(`${limitedBase}/actions/rpc`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${RPC_KEY}`,
            'x-connection-id': CONN_1,
          },
          body: JSON.stringify({ action: 'create_doc', args: { title: 'burst' } }),
        });
      expect((await call()).status).toBe(200);
      const second = await call();
      expect(second.status).toBe(429);
      const retryAfter = second.headers.get('retry-after');
      expect(retryAfter).toBeTruthy();
      const payload = (await second.json()) as { code: string; retryAfterSeconds: number };
      expect(payload.code).toBe('rate_limited');
      expect(payload.retryAfterSeconds).toBe(Number(retryAfter));
    } finally {
      await new Promise((resolve) => limitedServer.close(resolve));
    }
  });

  it('executes hidden actions over RPC — the direct-API path (T10 semantics)', async () => {
    const hiddenAction: Action = {
      name: 'purge_cache',
      description: 'Platform-internal cache purge; never advertised to agents.',
      inputSchema: { type: 'object', additionalProperties: false, properties: {}, required: [] },
      outputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: { purged: { type: 'boolean' } },
        required: ['purged'],
      },
      effects: 'write',
      hidden: true,
    };
    const connector = makeConnector('cache', ['purge_cache'], {
      purge_cache: () => ({ purged: true }),
    });
    const hiddenHarness = makeHarness({
      actions: [hiddenAction],
      connectors: [connector],
      connections: [{ tenantId: TENANT_A, connectionId: CONN_1, connectorId: 'cache' }],
    });
    const keys = new InMemoryMCPKeyStore();
    keys.addKey(RPC_KEY, TENANT_A);
    const app = createRpcApp({ executor: hiddenHarness.executor, keys });
    const hiddenServer = serve({ fetch: app.fetch, port: 0 });
    await new Promise((resolve) => hiddenServer.once('listening', resolve));
    const hiddenBase = `http://127.0.0.1:${(hiddenServer.address() as AddressInfo).port}`;
    try {
      const response = await fetch(`${hiddenBase}/actions/rpc`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${RPC_KEY}`,
          'x-connection-id': CONN_1,
        },
        body: JSON.stringify({ action: 'purge_cache' }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ purged: true });
    } finally {
      await new Promise((resolve) => hiddenServer.close(resolve));
    }
  });
});
