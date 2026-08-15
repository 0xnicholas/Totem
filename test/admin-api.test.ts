import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { serve, type ServerType } from '@hono/node-server';
import type { AddressInfo } from 'node:net';
import { createAdminApp } from '../src/admin/server.js';
import { ADMIN_AUDIT_ACTIONS } from '../src/admin/repo.js';
import { hashApiKey } from '../src/admin/keys.js';
import { FlowError } from '../src/oauth/authorize-flow.js';
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

  it('stores dingtalk app credentials for a tenant (T17a)', async () => {
    const tenant = await repo.createTenant('creds-tenant-dt');
    const response = await adminFetch(`/admin/tenants/${tenant.id}/dingtalk-creds`, {
      method: 'POST',
      body: JSON.stringify({ appKey: 'cli_app_key', appSecret: 's3cret' }),
    });
    expect(response.status).toBe(200);
    expect(repo.getDingTalkCreds(tenant.id)).toEqual({ appKey: 'cli_app_key', appSecret: 's3cret' });
  });

  it('400s on dingtalk creds with a missing field (T17a)', async () => {
    const tenant = await repo.createTenant('creds-tenant-dt2');
    const response = await adminFetch(`/admin/tenants/${tenant.id}/dingtalk-creds`, {
      method: 'POST',
      body: JSON.stringify({ appKey: 'only-key' }),
    });
    expect(response.status).toBe(400);
  });

  it('404s on feishu creds for an unknown tenant', async () => {
    const response = await adminFetch('/admin/tenants/00000000-0000-0000-0000-000000000000/feishu-creds', {
      method: 'POST',
      body: JSON.stringify({ appId: 'a', appSecret: 'b' }),
    });
    expect(response.status).toBe(404);
  });

  it('404s on dingtalk creds for an unknown tenant (T17a)', async () => {
    const response = await adminFetch('/admin/tenants/00000000-0000-0000-0000-000000000000/dingtalk-creds', {
      method: 'POST',
      body: JSON.stringify({ appKey: 'a', appSecret: 'b' }),
    });
    expect(response.status).toBe(404);
  });

  it('replaces a connection allowlist', async () => {
    const tenant = await repo.createTenant('allowlist-tenant');
    repo.addConnection(tenant.id, 'conn-1');
    repo.addConnection(tenant.id, 'conn-2');

    const first = await adminFetch('/admin/connections/conn-1/allowlist', {
      method: 'PUT',
      body: JSON.stringify({ actions: ['create_doc', 'get_doc_content'] }),
    });
    expect(first.status).toBe(200);

    // Replace, not append.
    const second = await adminFetch('/admin/connections/conn-1/allowlist', {
      method: 'PUT',
      body: JSON.stringify({ actions: ['search_docs'] }),
    });
    expect(second.status).toBe(200);
    expect(repo.listAllowlist('conn-1')).toEqual(['search_docs']);

    const unknown = await adminFetch('/admin/connections/conn-nope/allowlist', {
      method: 'PUT',
      body: JSON.stringify({ actions: [] }),
    });
    expect(unknown.status).toBe(404);
  });

  it('requires an explicit acknowledge for destructive allowlist entries (ADR-0018)', async () => {
    // A dedicated app with the platform's destructive set wired — the
    // production wiring (compose) always injects it.
    const localRepo = new InMemoryAdminRepository();
    const localApp = createAdminApp({
      repo: localRepo,
      adminKey: ADMIN_KEY,
      destructiveActions: new Set(['delete_doc', 'feishu_delete_bitable_records']),
    });
    const localServer = serve({ fetch: localApp.fetch, port: 0 });
    await new Promise((resolve) => localServer.once('listening', resolve));
    const localUrl = `http://127.0.0.1:${(localServer.address() as AddressInfo).port}`;
    const localFetch = (path: string, init: RequestInit = {}): Promise<Response> =>
      fetch(`${localUrl}${path}`, {
        ...init,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${ADMIN_KEY}`,
          ...init.headers,
        },
      });
    try {
      const tenant = await localRepo.createTenant('destructive-tenant');
      localRepo.addConnection(tenant.id, 'conn-destr');

      // No acknowledge: rejected, naming the offending entries.
      const bare = await localFetch('/admin/connections/conn-destr/allowlist', {
        method: 'PUT',
        body: JSON.stringify({ actions: ['create_doc', 'delete_doc'] }),
      });
      expect(bare.status).toBe(400);
      const bareBody = (await bare.json()) as { error: string };
      expect(bareBody.error).toContain('delete_doc');
      expect(bareBody.error).toContain('allowDestructive');

      // The acknowledge flag admits the list — the opting-in act is audited.
      const acknowledged = await localFetch('/admin/connections/conn-destr/allowlist', {
        method: 'PUT',
        body: JSON.stringify({
          actions: ['create_doc', 'delete_doc'],
          allowDestructive: true,
        }),
      });
      expect(acknowledged.status).toBe(200);
      const rows = await localRepo.queryAudit(tenant.id, {
        action: ADMIN_AUDIT_ACTIONS.allowlistUpdated,
      });
      const last = rows.at(-1);
      // paramHash covers {connectionId, actions, allowDestructive} — the
      // params cannot be read back, so the flag's presence is pinned by
      // the registry audit seam; here we assert the row exists.
      expect(last?.actionName).toBe('admin.allowlist_updated');
    } finally {
      await new Promise((resolve) => localServer.close(resolve));
    }
  });

  it('filters audit rows by the destructive stamp (ADR-0018)', async () => {
    const tenant = await repo.createTenant('destructive-filter-tenant');
    repo.seedAuditRow({
      tenantId: tenant.id,
      actionName: 'delete_doc',
      createdAt: '2026-08-15T10:00:00.000Z',
      metadata: { effects: 'destructive' },
    });
    repo.seedAuditRow({
      tenantId: tenant.id,
      actionName: 'create_doc',
      createdAt: '2026-08-15T10:01:00.000Z',
    });

    const destructive = await adminFetch(`/admin/tenants/${tenant.id}/audit?destructive=true`);
    expect(destructive.status).toBe(200);
    const body = (await destructive.json()) as { rows: Array<{ actionName: string }> };
    expect(body.rows.map((r) => r.actionName)).toEqual(['delete_doc']);

    // false = "not stamped destructive": unstamped rows are included
    // (the same semantics as the Postgres COALESCE) — tenant_created is
    // the admin mutation's own unstamped row.
    const plain = await adminFetch(`/admin/tenants/${tenant.id}/audit?destructive=false`);
    expect(plain.status).toBe(200);
    const plainBody = (await plain.json()) as { rows: Array<{ actionName: string }> };
    expect(plainBody.rows.map((r) => r.actionName)).toEqual(['create_doc', 'admin.tenant_created']);

    const rejected = await adminFetch(`/admin/tenants/${tenant.id}/audit?destructive=yes`);
    expect(rejected.status).toBe(400);
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

  it('reads and updates a tenant audit policy, auditing the change (T11)', async () => {
    const tenant = await repo.createTenant('policy-tenant');

    const defaults = await adminFetch(`/admin/tenants/${tenant.id}/audit-policy`);
    expect(defaults.status).toBe(200);
    expect(await defaults.json()).toEqual({
      retentionDays: 90,
      errorOnly: false,
      captureBody: false,
    });

    const updated = await adminFetch(`/admin/tenants/${tenant.id}/audit-policy`, {
      method: 'PUT',
      body: JSON.stringify({ retentionDays: 30, errorOnly: true }),
    });
    expect(updated.status).toBe(200);
    expect(await updated.json()).toEqual({
      retentionDays: 30,
      errorOnly: true,
      captureBody: false,
    });

    const audits = (await (
      await adminFetch(`/admin/tenants/${tenant.id}/audit?action=admin.audit_policy_updated`)
    ).json()) as { rows: Array<{ paramHash: string }> };
    expect(audits.rows).toHaveLength(1);
  });

  it('validates audit-policy patches and 404s unknown tenants (T11)', async () => {
    const tenant = await repo.createTenant('policy-bad-tenant');

    for (const body of [
      { retentionDays: 0 },
      { retentionDays: 3.5 },
      { retentionDays: 4000 },
      { errorOnly: 'yes' },
      { captureBody: 1 },
      { surprise: true },
    ]) {
      const response = await adminFetch(`/admin/tenants/${tenant.id}/audit-policy`, {
        method: 'PUT',
        body: JSON.stringify(body),
      });
      expect(response.status, JSON.stringify(body)).toBe(400);
    }

    const unknown = await adminFetch('/admin/tenants/00000000-0000-0000-0000-000000000000/audit-policy');
    expect(unknown.status).toBe(404);
  });

  it('reads and updates a tenant defender policy, auditing the change (T15)', async () => {
    const tenant = await repo.createTenant('defender-tenant');

    // Observe-first defaults: scanning on, blocking off.
    const defaults = await adminFetch(`/admin/tenants/${tenant.id}/defender-policy`);
    expect(defaults.status).toBe(200);
    expect(await defaults.json()).toEqual({ enabled: true, blockHighRisk: false });

    const updated = await adminFetch(`/admin/tenants/${tenant.id}/defender-policy`, {
      method: 'PUT',
      body: JSON.stringify({ blockHighRisk: true }),
    });
    expect(updated.status).toBe(200);
    expect(await updated.json()).toEqual({ enabled: true, blockHighRisk: true });

    const audits = (await (
      await adminFetch(`/admin/tenants/${tenant.id}/audit?action=admin.defender_policy_updated`)
    ).json()) as { rows: unknown[] };
    expect(audits.rows).toHaveLength(1);
  });

  it('validates defender-policy patches and 404s unknown tenants (T15)', async () => {
    const tenant = await repo.createTenant('defender-bad-tenant');

    for (const body of [{ enabled: 'yes' }, { blockHighRisk: 1 }, { surprise: true }]) {
      const response = await adminFetch(`/admin/tenants/${tenant.id}/defender-policy`, {
        method: 'PUT',
        body: JSON.stringify(body),
      });
      expect(response.status, JSON.stringify(body)).toBe(400);
    }

    const unknown = await adminFetch('/admin/tenants/00000000-0000-0000-0000-000000000000/defender-policy');
    expect(unknown.status).toBe(404);
  });

  it('purges expired audit rows per the tenant retention window (T11)', async () => {
    const tenant = await repo.createTenant('purge-tenant');
    const recent = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    repo.seedAuditRow({ tenantId: tenant.id, actionName: 'admin.key_issued', createdAt: '2020-01-01T00:00:00.000Z' });
    repo.seedAuditRow({ tenantId: tenant.id, actionName: 'admin.allowlist_updated', createdAt: recent });
    // A 7-day window keeps the recent row and drops the 2020 row.
    await adminFetch(`/admin/tenants/${tenant.id}/audit-policy`, {
      method: 'PUT',
      body: JSON.stringify({ retentionDays: 7 }),
    });

    const response = await adminFetch(`/admin/tenants/${tenant.id}/audit/purge`, { method: 'POST' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deleted: 1 });

    const remaining = (await (
      await adminFetch(`/admin/tenants/${tenant.id}/audit?action=admin.allowlist_updated`)
    ).json()) as { rows: unknown[] };
    expect(remaining.rows).toHaveLength(1);

    // The purge itself is audited.
    const purges = (await (
      await adminFetch(`/admin/tenants/${tenant.id}/audit?action=admin.audit_purged`)
    ).json()) as { rows: Array<{ paramHash: string }> };
    expect(purges.rows).toHaveLength(1);
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

  it('rejects an unknown connectorId with 400 (T17a)', async () => {
    flow.start.mockClear();
    const response = await adminFetch(`/admin/tenants/${tenantId}/oauth/start`, {
      method: 'POST',
      body: JSON.stringify({
        redirectUri: 'https://totem.example.com/oauth/callback/x',
        connectorId: 'no_such_connector',
      }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('unknown connector');
    expect(flow.start).not.toHaveBeenCalled();
  });

  it('404s a known connector whose flow is not configured (T17a)', async () => {
    flow.start.mockClear();
    const response = await adminFetch(`/admin/tenants/${tenantId}/oauth/start`, {
      method: 'POST',
      body: JSON.stringify({
        redirectUri: 'https://totem.example.com/oauth/callback/dingtalk',
        connectorId: 'dingtalk_docs',
      }),
    });
    expect(response.status).toBe(404);
    expect(flow.start).not.toHaveBeenCalled();
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

  it('encrypts dingtalk app secrets via the injected cipher (T17a)', async () => {
    await adminFetch(`/admin/tenants/${tenantId}/dingtalk-creds`, {
      method: 'POST',
      body: JSON.stringify({ appKey: 'app-1', appSecret: 'super-secret' }),
    });
    const stored = repo.getDingTalkCreds(tenantId);
    expect(stored?.appSecret).toBe(`v1:${tenantId}:super-secret`);
  });
});
