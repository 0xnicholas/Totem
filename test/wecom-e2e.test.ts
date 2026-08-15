import { serve, type ServerType } from '@hono/node-server';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { migrateUp } from '../scripts/migrate.mjs';
import { AdminApiClient } from '../src/admin/client.js';
import { decryptValue, isCiphertext } from '../src/crypto.js';
import { composeServer } from '../src/server/compose.js';
import { MockWeComServer } from '../src/testing/mock-wecom-server.js';

/**
 * Full-stack #48 (ADR-0017): the credential-connection form through the
 * composed server — exactly the production wiring (Postgres stores, real
 * crypto) against the mock WeCom API. Covers the ACs: creds registration
 * creates the connection (encrypted secret at rest, audited), rotation
 * keeps exactly one connection, the authorize flow is loudly absent for
 * the credential connector, and — per ADR-0017's "no connector consumes
 * the form before it" — an allowlisted action on the connection is
 * governed (allowlist + audit) but not executable until #47's connector.
 */
const dbUrl = process.env.DATABASE_URL;
const hasDb = Boolean(dbUrl);

describe.runIf(hasDb)('WeCom credential connection end to end (Postgres, #48)', () => {
  const pool = new pg.Pool({ connectionString: dbUrl });
  const MASTER_KEY = 'e2e-master-key-0123456789abcdef0123456789abcdef';
  const ADMIN_KEY = 'e2e-admin-key';
  const CORP_ID = 'e2e_ww_corp';
  const SECRET = 'e2e_ww_secret';
  const AGENT_ID = '1000002';

  let wecom: ServerType;
  let api: ServerType;
  let apiBaseUrl: string;
  let client: AdminApiClient;
  let tenantId: string;

  beforeAll(async () => {
    await migrateUp(dbUrl!);
    await pool.query("DELETE FROM tenants WHERE name NOT LIKE 'live-%'");

    const mock = new MockWeComServer({ corpId: CORP_ID, secret: SECRET });
    wecom = serve({ fetch: mock.app.fetch, port: 0 });
    await new Promise((resolve) => wecom.once('listening', resolve));
    const wecomBaseUrl = `http://127.0.0.1:${(wecom.address() as AddressInfo).port}`;

    const app = composeServer(pool, {
      masterKey: MASTER_KEY,
      adminKey: ADMIN_KEY,
      wecomApiBaseUrl: wecomBaseUrl,
    });
    api = serve({ fetch: app.fetch, port: 0 });
    await new Promise((resolve) => api.once('listening', resolve));
    apiBaseUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
    client = new AdminApiClient({ baseUrl: apiBaseUrl, apiKey: ADMIN_KEY });

    tenantId = (await client.createTenant('e2e-wecom')).id;
  });

  afterAll(async () => {
    if (api) await new Promise((resolve) => api.close(resolve));
    if (wecom) await new Promise((resolve) => wecom.close(resolve));
    // Leave the database as found (issue #27).
    try {
      await pool.query("DELETE FROM tenants WHERE name NOT LIKE 'live-%'");
    } catch {
      // beforeAll may have failed; never mask the original error.
    }
    await pool.end();
  });

  it('registers wecom credentials: encrypted secret row + audited credential connection', async () => {
    const { connectionId } = await client.setWecomCreds(tenantId, CORP_ID, SECRET, AGENT_ID);

    const row = (
      await pool.query<{ corp_id: string; agent_id: string; secret: string }>(
        'SELECT corp_id, agent_id, secret FROM wecom_credentials WHERE tenant_id = $1',
        [tenantId],
      )
    ).rows[0];
    expect(row).toMatchObject({ corp_id: CORP_ID, agent_id: AGENT_ID });
    expect(isCiphertext(row!.secret)).toBe(true);
    expect(decryptValue(tenantId, row!.secret, MASTER_KEY)).toBe(SECRET);

    const { connections } = await client.listConnections(tenantId);
    expect(connections).toHaveLength(1);
    expect(connections[0]).toMatchObject({
      id: connectionId,
      connectorId: 'wecom_messaging',
      status: 'active',
      ownerId: tenantId,
      oauthRedirectUri: null,
    });

    const created = await client.queryAudit(tenantId, { action: 'admin.connection_created' });
    expect(created.rows).toHaveLength(1);
    expect(created.rows[0]).toMatchObject({ connectionId });
    const credsAudit = await client.queryAudit(tenantId, { action: 'admin.wecom_creds_updated' });
    expect(credsAudit.rows).toHaveLength(1);
  });

  it('rotates credentials without duplicating the connection', async () => {
    const first = await client.setWecomCreds(tenantId, CORP_ID, SECRET, AGENT_ID);
    const second = await client.setWecomCreds(tenantId, 'ww_rotated', 'secret-2', '1000003');
    expect(second.connectionId).toBe(first.connectionId);

    const { connections } = await client.listConnections(tenantId);
    expect(connections).toHaveLength(1);

    const row = (
      await pool.query<{ corp_id: string }>(
        'SELECT corp_id FROM wecom_credentials WHERE tenant_id = $1',
        [tenantId],
      )
    ).rows[0];
    expect(row).toMatchObject({ corp_id: 'ww_rotated' });
    // Rotation audited again, but no second connection_created row.
    const created = await client.queryAudit(tenantId, { action: 'admin.connection_created' });
    expect(created.rows).toHaveLength(1);
  });

  it('rejects the authorize flow for the credential connector with the registration pointer', async () => {
    const response = await fetch(`${apiBaseUrl}/admin/tenants/${tenantId}/oauth/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ADMIN_KEY}` },
      body: JSON.stringify({
        redirectUri: 'https://totem.example.com/oauth/callback/none',
        connectorId: 'wecom_messaging',
      }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('credential connector');
    expect(body.error).toContain('wecom-creds');
  });

  it('governs the connection today but executes nothing until #47: allowlisted send_message fails not_found (connector unregistered)', async () => {
    // Restore working creds (the rotation test replaced them).
    await client.setWecomCreds(tenantId, CORP_ID, SECRET, AGENT_ID);
    const { connections } = await client.listConnections(tenantId);
    const connection = connections[0]!;
    await client.setAllowlist(connection.id, ['send_message']);

    const key = await client.createKey(tenantId, 'actions');
    const response = await fetch(`${apiBaseUrl}/actions/rpc`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key.key}`,
        'x-connection-id': connection.id,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        action: 'send_message',
        args: { chat_id: 'e2e-chat', content: 'hello' },
      }),
    });
    // The connection is real and allowlisted, but no connector is
    // registered for wecom_messaging yet (ADR-0017 item 6: no connector
    // consumes the form before #47) — the executor's defensive branch:
    // not_found "connector not registered". When #47's connector lands,
    // this becomes the ordinary hide-don't-reject action_not_found path.
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      code: 'not_found',
      retryable: false,
    });

    // The failed attempt is audited like any execution (governance applies
    // to both connection kinds, ADR-0017 item 4).
    const audit = await client.queryAudit(tenantId, { action: 'send_message' });
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({
      connectionId: connection.id,
      success: false,
      errorCode: 'not_found',
    });
  });
});
