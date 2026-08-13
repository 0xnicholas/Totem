import { serve, type ServerType } from '@hono/node-server';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashApiKey } from '../src/admin/keys.js';
import { createAdminApp } from '../src/admin/server.js';
import { McpAdapter } from '../src/mcp/adapter.js';
import { createMcpApp } from '../src/mcp/server.js';
import { createDiscoveryApp } from '../src/rest/discovery.js';
import { createRpcApp } from '../src/rest/rpc.js';
import { InMemoryAdminRepository } from '../src/testing/memory-admin-repo.js';
import { InMemoryMCPKeyStore } from '../src/testing/memory-key-store.js';
import { CONN_1, TENANT_A, makeHarness } from './fixtures.js';

const ACTIONS_KEY = 'tt_dev_auth_actions';
const ADMIN_KEY = 'test-admin-key';
const TENANT_ADMIN_KEY = 'tt_dev_auth_tenant_admin';
const DISABLED_KEY = 'tt_dev_auth_disabled';

/**
 * The platform auth module (src/auth.ts): the caller-identity matrix
 * driven through every real surface. One suite owns the auth semantics —
 * missing/unknown/disabled/admin-scoped keys 401 on the consumer surfaces,
 * the bootstrap key or an admin-scoped tenant key gates /admin, and the
 * x-connection-id addressing 400s when absent. The per-surface suites keep
 * only surface-specific behavior.
 */
describe('tenant-key auth module (through every surface)', () => {
  let server: ServerType;
  let baseUrl: string;
  let mcpApp: ReturnType<typeof createMcpApp>;
  let rpcApp: ReturnType<typeof createRpcApp>;
  let discoveryApp: ReturnType<typeof createDiscoveryApp>;
  let adminApp: ReturnType<typeof createAdminApp>;

  beforeAll(async () => {
    const harness = makeHarness();
    const keys = new InMemoryMCPKeyStore();
    keys.addKey(ACTIONS_KEY, TENANT_A);
    keys.addKey(TENANT_ADMIN_KEY, TENANT_A, { scope: 'admin' });
    keys.addKey(DISABLED_KEY, TENANT_A, { disabled: true });

    const repo = new InMemoryAdminRepository();
    const tenant = await repo.createTenant('auth-tenant');
    await repo.createApiKey(tenant.id, 'admin', {
      prefix: 'tt_dev_',
      keyHash: hashApiKey(TENANT_ADMIN_KEY),
    });
    const revokedAdmin = await repo.createApiKey(tenant.id, 'admin', {
      prefix: 'tt_dev_',
      keyHash: hashApiKey('tt_dev_auth_revoked_admin'),
    });
    await repo.disableApiKey(tenant.id, revokedAdmin.id);

    mcpApp = createMcpApp({
      adapter: new McpAdapter(harness.executor, harness.allowlists),
      keys,
    });
    rpcApp = createRpcApp({ executor: harness.executor, keys });
    discoveryApp = createDiscoveryApp({ actions: harness.executor.listActions(), keys });
    adminApp = createAdminApp({ repo, adminKey: ADMIN_KEY });

    // Serve the surfaces behind one origin (like production's one process).
    const { Hono } = await import('hono');
    const app = new Hono();
    app.route('/mcp', mcpApp);
    app.route('/', discoveryApp);
    app.route('/', rpcApp);
    app.route('/', adminApp);
    server = serve({ fetch: app.fetch, port: 0 });
    await new Promise((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  function mcpRequest(init: RequestInit = {}): Promise<Response> {
    return fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...init.headers,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
      ...init,
    });
  }

  function rpcRequest(init: RequestInit = {}): Promise<Response> {
    return fetch(`${baseUrl}/actions/rpc`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${ACTIONS_KEY}`,
        'x-connection-id': CONN_1,
        ...init.headers,
      },
      body: JSON.stringify({ action: 'create_doc' }),
      ...init,
    });
  }

  function discoveryRequest(init: RequestInit = {}): Promise<Response> {
    return fetch(`${baseUrl}/actions`, { ...init, headers: { ...init.headers } });
  }

  function adminRequest(init: RequestInit = {}): Promise<Response> {
    return fetch(`${baseUrl}/admin/tenants`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...init.headers },
      body: JSON.stringify({ name: 'auth-probe' }),
      ...init,
    });
  }

  describe('consumer surfaces (mcp, rpc, discovery)', () => {
    it('reject requests without an Authorization header with 401', async () => {
      for (const request of [mcpRequest, rpcRequest, discoveryRequest]) {
        expect((await request({ headers: {} })).status).toBe(401);
      }
    });

    it('reject unknown keys with 401', async () => {
      for (const request of [mcpRequest, rpcRequest, discoveryRequest]) {
        expect(
          (await request({ headers: { authorization: 'Bearer tt_dev_unknown_key' } })).status,
        ).toBe(401);
      }
    });

    it('reject admin-scoped tenant keys with 401 (actions scope only)', async () => {
      for (const request of [mcpRequest, rpcRequest, discoveryRequest]) {
        expect(
          (await request({ headers: { authorization: `Bearer ${TENANT_ADMIN_KEY}` } })).status,
        ).toBe(401);
      }
    });

    it('reject disabled keys with 401', async () => {
      for (const request of [mcpRequest, rpcRequest, discoveryRequest]) {
        expect(
          (await request({ headers: { authorization: `Bearer ${DISABLED_KEY}` } })).status,
        ).toBe(401);
      }
    });

    it('accept a valid actions-scoped key (auth passes; surface handles the rest)', async () => {
      expect((await mcpRequest({ headers: { authorization: `Bearer ${ACTIONS_KEY}`, 'x-connection-id': CONN_1 } })).status).not.toBe(401);
      expect((await rpcRequest({ headers: { authorization: `Bearer ${ACTIONS_KEY}` } })).status).not.toBe(401);
      expect(
        (await discoveryRequest({ headers: { authorization: `Bearer ${ACTIONS_KEY}` } })).status,
      ).toBe(200);
    });
  });

  describe('connection addressing (mcp, rpc)', () => {
    it('reject requests without an x-connection-id with 400', async () => {
      const headers = { authorization: `Bearer ${ACTIONS_KEY}` };
      expect((await mcpRequest({ headers })).status).toBe(400);
      expect((await rpcRequest({ headers })).status).toBe(400);
    });
  });

  describe('admin surface', () => {
    it('rejects requests without a key, with a wrong key, with an actions-scoped key, or with a revoked admin key', async () => {
      expect((await adminRequest({ headers: {} })).status).toBe(401);
      expect((await adminRequest({ headers: { authorization: 'Bearer nope' } })).status).toBe(401);
      expect(
        (await adminRequest({ headers: { authorization: `Bearer ${ACTIONS_KEY}` } })).status,
      ).toBe(401);
      expect(
        (
          await adminRequest({
            headers: { authorization: 'Bearer tt_dev_auth_revoked_admin' },
          })
        ).status,
      ).toBe(401);
    });

    it('accepts the bootstrap admin key', async () => {
      expect(
        (await adminRequest({ headers: { authorization: `Bearer ${ADMIN_KEY}` } })).status,
      ).toBe(201);
    });

    it('accepts an admin-scoped tenant key', async () => {
      expect(
        (await adminRequest({ headers: { authorization: `Bearer ${TENANT_ADMIN_KEY}` } })).status,
      ).toBe(201);
    });

    it('leaves /healthz unauthenticated', async () => {
      expect((await fetch(`${baseUrl}/healthz`)).status).toBe(200);
    });
  });
});
