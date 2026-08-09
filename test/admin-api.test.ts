import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { serve, type ServerType } from '@hono/node-server';
import type { AddressInfo } from 'node:net';
import { createAdminApp } from '../src/admin/server.js';
import { hashApiKey } from '../src/admin/keys.js';
import { FlowError } from '../src/feishu/flow.js';
import { InMemoryAdminRepository } from '../src/testing/memory-admin-repo.js';

const ADMIN_KEY = 'test-admin-key';

describe('admin API (HTTP boundary)', () => {
  let repo: InMemoryAdminRepository;
  let server: ServerType;
  let baseUrl: string;

  beforeAll(async () => {
    repo = new InMemoryAdminRepository();
    const app = createAdminApp({ repo, adminKey: ADMIN_KEY });
    server = serve({ fetch: app.fetch, port: 0 });
    await new Promise((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  function adminFetch(path: string, init: RequestInit = {}): Promise<Response> {
    return fetch(`${baseUrl}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ADMIN_KEY}`, ...init.headers },
    });
  }

  it('rejects requests without a valid admin key', async () => {
    const response = await fetch(`${baseUrl}/admin/tenants`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'x' }),
    });
    expect(response.status).toBe(401);

    const wrongKey = await fetch(`${baseUrl}/admin/tenants`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer nope' },
      body: JSON.stringify({ name: 'x' }),
    });
    expect(wrongKey.status).toBe(401);
  });

  it('serves /healthz without auth', async () => {
    const response = await fetch(`${baseUrl}/healthz`);
    expect(response.status).toBe(200);
  });

  it('authenticates with an admin-scoped tenant key', async () => {
    const tenant = await repo.createTenant('admin-key-tenant');
    await repo.createApiKey(tenant.id, 'admin', {
      prefix: 'tt_dev_',
      keyHash: hashApiKey('tenant-admin-key'),
    });

    const response = await fetch(`${baseUrl}/admin/tenants`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer tenant-admin-key' },
      body: JSON.stringify({ name: 'via-admin-scope' }),
    });
    expect(response.status).toBe(201);
  });

  it('rejects action-scoped and disabled admin keys', async () => {
    const tenant = await repo.createTenant('scope-tenant-2');
    await repo.createApiKey(tenant.id, 'actions', {
      prefix: 'tt_dev_',
      keyHash: hashApiKey('actions-key'),
    });
    const adminKey = await repo.createApiKey(tenant.id, 'admin', {
      prefix: 'tt_dev_',
      keyHash: hashApiKey('revoked-admin-key'),
    });
    await repo.disableApiKey(tenant.id, adminKey.id);

    for (const bearer of ['actions-key', 'revoked-admin-key']) {
      const response = await fetch(`${baseUrl}/admin/tenants`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
        body: JSON.stringify({ name: 'nope' }),
      });
      expect(response.status, `key ${bearer}`).toBe(401);
    }
  });

  it('creates a tenant and returns its id', async () => {
    const response = await adminFetch('/admin/tenants', {
      method: 'POST',
      body: JSON.stringify({ name: 'acme' }),
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as { id: string; name: string };
    expect(body.name).toBe('acme');
    expect(body.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('issues a tt_dev_-prefixed key, storing only the hash', async () => {
    const tenant = await repo.createTenant('key-tenant');

    const response = await adminFetch(`/admin/tenants/${tenant.id}/keys`, {
      method: 'POST',
      body: JSON.stringify({ scope: 'actions' }),
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as { key: string; id: string; scope: string; prefix: string };
    expect(body.key).toMatch(/^tt_dev_[A-Za-z0-9_-]{43}$/);
    expect(body.prefix).toBe('tt_dev_');
    expect(body.scope).toBe('actions');

    // The plaintext appears once: the stored record holds only the hash.
    const record = (await repo.getApiKey(tenant.id, body.id))!;
    expect(record.keyHash).toBe(hashApiKey(body.key));
    expect(record.keyHash).not.toContain(body.key);
  });

  it('rejects an invalid key scope', async () => {
    const tenant = await repo.createTenant('scope-tenant');
    const response = await adminFetch(`/admin/tenants/${tenant.id}/keys`, {
      method: 'POST',
      body: JSON.stringify({ scope: 'superuser' }),
    });
    expect(response.status).toBe(400);
  });

  it('disables a key (idempotently) and 404s on unknown keys', async () => {
    const tenant = await repo.createTenant('disable-tenant');
    const key = await repo.createApiKey(tenant.id, 'actions', {
      prefix: 'tt_dev_',
      keyHash: hashApiKey('some-key'),
    });

    const first = await adminFetch(`/admin/tenants/${tenant.id}/keys/${key.id}/disable`, { method: 'POST' });
    expect(first.status).toBe(200);

    const again = await adminFetch(`/admin/tenants/${tenant.id}/keys/${key.id}/disable`, { method: 'POST' });
    expect(again.status).toBe(200);
    expect((await again.json()) as { changed: boolean }).toEqual({ changed: false });

    const missing = await adminFetch(`/admin/tenants/${tenant.id}/keys/00000000-0000-0000-0000-000000000000/disable`, {
      method: 'POST',
    });
    expect(missing.status).toBe(404);
  });

  it('stores feishu app credentials for a tenant', async () => {
    const tenant = await repo.createTenant('creds-tenant');
    const response = await adminFetch(`/admin/tenants/${tenant.id}/feishu-creds`, {
      method: 'POST',
      body: JSON.stringify({ appId: 'cli_app_id', appSecret: 's3cret' }),
    });
    expect(response.status).toBe(200);
    expect(repo.getFeishuCreds(tenant.id)).toEqual({ appId: 'cli_app_id', appSecret: 's3cret' });
  });

  it('404s on feishu creds for an unknown tenant', async () => {
    const response = await adminFetch('/admin/tenants/00000000-0000-0000-0000-000000000000/feishu-creds', {
      method: 'POST',
      body: JSON.stringify({ appId: 'a', appSecret: 'b' }),
    });
    expect(response.status).toBe(404);
  });

  it('replaces a connection allowlist', async () => {
    const tenant = await repo.createTenant('allowlist-tenant');
    repo.addConnection(tenant.id, 'conn-1');
    repo.addConnection(tenant.id, 'conn-2');

    const first = await adminFetch('/admin/connections/conn-1/allowlist', {
      method: 'PUT',
      body: JSON.stringify({ actions: ['create_doc', 'read_doc'] }),
    });
    expect(first.status).toBe(200);

    // Replace, not append.
    const second = await adminFetch('/admin/connections/conn-1/allowlist', {
      method: 'PUT',
      body: JSON.stringify({ actions: ['list_docs'] }),
    });
    expect(second.status).toBe(200);
    expect(repo.listAllowlist('conn-1')).toEqual(['list_docs']);

    const unknown = await adminFetch('/admin/connections/conn-nope/allowlist', {
      method: 'PUT',
      body: JSON.stringify({ actions: [] }),
    });
    expect(unknown.status).toBe(404);
  });

  it('suspends and resumes a connection', async () => {
    const tenant = await repo.createTenant('suspend-tenant');
    repo.addConnection(tenant.id, 'conn-9');

    const suspend = await adminFetch('/admin/connections/conn-9/suspend', { method: 'POST' });
    expect(suspend.status).toBe(200);
    expect(repo.getConnectionStatus('conn-9')).toBe('suspended');

    const resume = await adminFetch('/admin/connections/conn-9/resume', { method: 'POST' });
    expect(resume.status).toBe(200);
    expect(repo.getConnectionStatus('conn-9')).toBe('active');
  });

  it('queries audit rows with filters', async () => {
    const tenant = await repo.createTenant('audit-tenant');
    repo.addConnection(tenant.id, 'conn-7');
    await repo.setAllowlist('conn-7', ['create_doc']);
    await repo.suspendConnection('conn-7', true);

    const all = await adminFetch(`/admin/tenants/${tenant.id}/audit`);
    expect(all.status).toBe(200);
    const body = (await all.json()) as { rows: Array<{ actionName: string; userId: string; source: string; connectionId: string | null }> };
    expect(body.rows.map((r) => r.actionName)).toEqual([
      'admin.connection_suspended',
      'admin.allowlist_updated',
      'admin.tenant_created',
    ]);
    expect(body.rows[0]).toMatchObject({ userId: 'admin', source: 'admin_api', connectionId: 'conn-7' });

    const filtered = await adminFetch(`/admin/tenants/${tenant.id}/audit?action=admin.allowlist_updated`);
    const filteredBody = (await filtered.json()) as { rows: Array<{ actionName: string }> };
    expect(filteredBody.rows).toHaveLength(1);

    const sourceFiltered = await adminFetch(`/admin/tenants/${tenant.id}/audit?source=cli`);
    const sourceBody = (await sourceFiltered.json()) as { rows: unknown[] };
    expect(sourceBody.rows).toHaveLength(0);
  });

  it('validates malformed bodies with a 400', async () => {
    const response = await adminFetch('/admin/tenants', {
      method: 'POST',
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(400);
  });

  it('404s unknown routes', async () => {
    const response = await adminFetch('/admin/nope');
    expect(response.status).toBe(404);
  });
});

describe('admin API: OAuth flow and connections (T6)', () => {
  let repo: InMemoryAdminRepository;
  let server: ServerType;
  let baseUrl: string;
  let tenantId: string;
  const flow = {
    start: vi.fn((tenant: string, redirectUri: string) =>
      Promise.resolve({
        authorizationUrl: `https://open.feishu.cn/open-apis/authen/v1/authorize?app_id=a&redirect_uri=${encodeURIComponent(redirectUri)}&state=st-${tenant}`,
      }),
    ),
    handleCallback: vi.fn(() => Promise.resolve(undefined)),
  };
  const secretCipher = {
    encrypt: (tenant: string, plaintext: string) => `v1:${tenant}:${plaintext}`,
  };

  beforeAll(async () => {
    repo = new InMemoryAdminRepository();
    tenantId = (await repo.createTenant('oauth-tenant')).id;
    const app = createAdminApp({ repo, adminKey: ADMIN_KEY, oauth: flow, secretCipher });
    server = serve({ fetch: app.fetch, port: 0 });
    await new Promise((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  function adminFetch(path: string, init: RequestInit = {}): Promise<Response> {
    return fetch(`${baseUrl}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ADMIN_KEY}`, ...init.headers },
    });
  }

  it('requires the admin key to start the OAuth flow', async () => {
    const response = await fetch(`${baseUrl}/admin/tenants/${tenantId}/oauth/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirectUri: 'https://totem.example.com/oauth/callback/feishu' }),
    });
    expect(response.status).toBe(401);
    expect(flow.start).not.toHaveBeenCalled();
  });

  it('starts the flow and returns the authorization URL', async () => {
    const response = await adminFetch(`/admin/tenants/${tenantId}/oauth/start`, {
      method: 'POST',
      body: JSON.stringify({ redirectUri: 'https://totem.example.com/oauth/callback/feishu' }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { authorizationUrl: string };
    expect(body.authorizationUrl).toContain('state=st-');
    expect(flow.start).toHaveBeenCalledWith(
      tenantId,
      'https://totem.example.com/oauth/callback/feishu',
      undefined,
    );
  });

  it('rejects starting the flow without a redirect URI', async () => {
    const response = await adminFetch(`/admin/tenants/${tenantId}/oauth/start`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(400);
  });

  it('surfaces FlowError statuses from the flow', async () => {
    flow.start.mockRejectedValueOnce(new FlowError(400, 'no credentials configured'));
    const response = await adminFetch(`/admin/tenants/${tenantId}/oauth/start`, {
      method: 'POST',
      body: JSON.stringify({ redirectUri: 'https://totem.example.com/oauth/callback/feishu' }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'no credentials configured' });
  });

  it('handles the public callback without an admin key', async () => {
    const response = await fetch(
      `${baseUrl}/oauth/callback/feishu?code=abc&state=st-x`,
    );
    expect(response.status).toBe(200);
    expect(flow.handleCallback).toHaveBeenCalledWith('abc', 'st-x');
  });

  it('maps callback FlowErrors to their status', async () => {
    flow.handleCallback.mockRejectedValueOnce(new FlowError(400, 'unknown state'));
    const response = await fetch(`${baseUrl}/oauth/callback/feishu?code=abc&state=bogus`);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'unknown state' });
  });

  it('lists connections with their auth state per tenant', async () => {
    repo.addConnection(tenantId, 'conn-active');
    repo.addConnection(tenantId, 'conn-expired', 'auth_expired');
    const response = await adminFetch(`/admin/tenants/${tenantId}/connections`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { connections: Array<{ id: string; status: string }> };
    expect(body.connections.map((c) => [c.id, c.status])).toEqual([
      ['conn-active', 'active'],
      ['conn-expired', 'auth_expired'],
    ]);

    const missing = await adminFetch('/admin/tenants/00000000-0000-0000-0000-000000000000/connections');
    expect(missing.status).toBe(404);
  });

  it('encrypts feishu app secrets via the injected cipher (issue #15)', async () => {
    await adminFetch(`/admin/tenants/${tenantId}/feishu-creds`, {
      method: 'POST',
      body: JSON.stringify({ appId: 'app-1', appSecret: 'super-secret' }),
    });
    const stored = repo.getFeishuCreds(tenantId);
    expect(stored?.appSecret).toBe(`v1:${tenantId}:super-secret`);
  });
});
