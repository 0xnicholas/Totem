import { serve, type ServerType } from '@hono/node-server';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { migrateUp } from '../scripts/migrate.mjs';
import { AdminApiClient } from '../src/admin/client.js';
import { decryptValue, isCiphertext } from '../src/feishu/crypto.js';
import { composeServer } from '../src/server/compose.js';
import { MockDingTalkServer } from '../src/testing/mock-dingtalk-server.js';

/**
 * Full-stack T17a: the composed server (exactly the production wiring —
 * Postgres stores, real crypto, both connectors and the routed token
 * provider) against the mock DingTalk server, driven with the real admin
 * client + browser-style callback fetch. Covers the ACs: admin register +
 * encrypted-at-rest creds, authorize flow → dingtalk_docs connection,
 * encrypted tokens, and `test_connection` executed through the REST RPC
 * surface with allowlist + audit — the Feishu path stays untouched (its
 * own e2e suite covers it).
 */
const dbUrl = process.env.DATABASE_URL;
const hasDb = Boolean(dbUrl);

describe.runIf(hasDb)('DingTalk connection end to end (Postgres)', () => {
  const pool = new pg.Pool({ connectionString: dbUrl });
  const MASTER_KEY = 'e2e-master-key-0123456789abcdef0123456789abcdef';
  const ADMIN_KEY = 'e2e-admin-key';
  const REDIRECT_URI = 'https://totem.example.com/oauth/callback/dingtalk';
  const APP_KEY = 'e2e_app_key';
  const APP_SECRET = 'e2e_app_secret';

  let dingtalk: ServerType;
  let dingtalkBaseUrl: string;
  let mock: MockDingTalkServer;
  let api: ServerType;
  let apiBaseUrl: string;
  let client: AdminApiClient;
  let tenantId: string;

  beforeAll(async () => {
    await migrateUp(dbUrl!);
    await pool.query('TRUNCATE tenants CASCADE');

    mock = new MockDingTalkServer({ appKey: APP_KEY, appSecret: APP_SECRET });
    mock.seedDocs([
      {
        docKey: 'e2e-doc-1',
        name: 'E2E Strategy',
        content: '# Strategy\n\nE2E content.',
        ownerUnionId: 'mock-union-id',
        updatedTime: Date.parse('2026-03-01T10:00:00Z'),
      },
    ]);
    mock.seedWorkbooks([
      {
        workbookId: 'e2e-wb-1',
        name: 'E2E Budget',
        ownerUnionId: 'mock-union-id',
        sheets: [
          { id: 'e2e-sht-a', name: 'Summary', values: [['Region', 'Q1'], ['APAC', 10]] },
          { id: 'e2e-sht-b', name: 'Detail', values: [['untouched']] },
        ],
      },
    ]);
    dingtalk = serve({ fetch: mock.app.fetch, port: 0 });
    await new Promise((resolve) => dingtalk.once('listening', resolve));
    dingtalkBaseUrl = `http://127.0.0.1:${(dingtalk.address() as AddressInfo).port}`;

    const app = composeServer(pool, {
      masterKey: MASTER_KEY,
      adminKey: ADMIN_KEY,
      dingtalkApiBaseUrl: dingtalkBaseUrl,
      dingtalkAuthorizeBaseUrl: dingtalkBaseUrl,
    });
    api = serve({ fetch: app.fetch, port: 0 });
    await new Promise((resolve) => api.once('listening', resolve));
    apiBaseUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
    client = new AdminApiClient({ baseUrl: apiBaseUrl, apiKey: ADMIN_KEY });

    tenantId = (await client.createTenant('e2e-dingtalk')).id;
  });

  afterAll(async () => {
    if (api) await new Promise((resolve) => api.close(resolve));
    if (dingtalk) await new Promise((resolve) => dingtalk.close(resolve));
    // Leave the database as found: truncate fixtures so repeated runs
    // against a dev DB never accumulate leftover tenants (issue #27).
    try {
      await pool.query('TRUNCATE tenants CASCADE');
    } catch {
      // beforeAll may have failed (e.g. an unreachable database); never
      // mask the original error.
    }
    await pool.end();
  });

  it('stores dingtalk app credentials as ciphertext, decryptable with the tenant key', async () => {
    await client.setDingTalkCreds(tenantId, APP_KEY, APP_SECRET);
    const row = (
      await pool.query<{ app_key: string; app_secret: string }>(
        'SELECT app_key, app_secret FROM dingtalk_credentials WHERE tenant_id = $1',
        [tenantId],
      )
    ).rows[0];
    expect(row?.app_key).toBe(APP_KEY);
    expect(row?.app_secret).not.toContain(APP_SECRET);
    expect(isCiphertext(row?.app_secret ?? '')).toBe(true);
    expect(decryptValue(tenantId, row!.app_secret, MASTER_KEY)).toBe(APP_SECRET);
  });

  it('walks the DingTalk flow: start → authorize → callback → dingtalk_docs connection + encrypted tokens', async () => {
    const { authorizationUrl } = await client.startOAuth(
      tenantId,
      REDIRECT_URI,
      undefined,
      'dingtalk_docs',
    );
    expect(authorizationUrl).toContain('/oauth2/auth');
    expect(authorizationUrl).toContain('client_id=');

    // The user authorizes: follow the mock's authorize redirect manually.
    const authorize = await fetch(authorizationUrl, { redirect: 'manual' });
    const callback = new URL(authorize.headers.get('location')!);
    const code = callback.searchParams.get('code')!;
    const state = callback.searchParams.get('state')!;

    const callbackResponse = await fetch(
      `${apiBaseUrl}${callback.pathname}?code=${code}&state=${state}`,
    );
    expect(callbackResponse.status).toBe(200);

    const { connections } = await client.listConnections(tenantId);
    expect(connections).toHaveLength(1);
    const connection = connections[0]!;
    expect(connection).toMatchObject({
      connectorId: 'dingtalk_docs',
      status: 'active',
      ownerId: tenantId,
      oauthRedirectUri: REDIRECT_URI,
    });

    const tokenRow = (
      await pool.query<{ user_access_token: string; refresh_token: string }>(
        'SELECT user_access_token, refresh_token FROM tokens WHERE connection_id = $1',
        [connection.id],
      )
    ).rows[0];
    expect(isCiphertext(tokenRow?.user_access_token ?? '')).toBe(true);
    expect(isCiphertext(tokenRow?.refresh_token ?? '')).toBe(true);
    expect(decryptValue(tenantId, tokenRow!.user_access_token, MASTER_KEY)).toBeTruthy();

    const audit = await client.queryAudit(tenantId, { action: 'admin.connection_created' });
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]?.connectionId).toBe(connection.id);
  });

  it('executes test_connection through the REST RPC surface with allowlist + audit', async () => {
    const { connections } = await client.listConnections(tenantId);
    const connection = connections[0]!;
    await client.setAllowlist(connection.id, ['test_connection']);

    const key = await client.createKey(tenantId, 'actions');
    const response = await fetch(`${apiBaseUrl}/actions/rpc`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key.key}`,
        'x-connection-id': connection.id,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ action: 'test_connection', args: {} }),
    });
    expect(response.status).toBe(200);
    const payload = (await response.json()) as { connection_id: string; status: string };
    expect(payload).toEqual({ connection_id: connection.id, status: 'ok' });

    const audit = await client.queryAudit(tenantId, { action: 'test_connection' });
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({
      connectionId: connection.id,
      success: true,
      errorCode: null,
    });
  });

  it('executes a read action through the RPC surface with List Envelope + audit (T17b)', async () => {
    const { connections } = await client.listConnections(tenantId);
    const connection = connections[0]!;
    await client.setAllowlist(connection.id, ['search_docs', 'get_doc_content']);

    const key = await client.createKey(tenantId, 'actions');
    const search = await fetch(`${apiBaseUrl}/actions/rpc`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key.key}`,
        'x-connection-id': connection.id,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ action: 'search_docs', args: { query: 'strategy' } }),
    });
    expect(search.status).toBe(200);
    const searchPayload = (await search.json()) as {
      data: Array<{ doc_id: string; title: string; doc_type: string }>;
      next: string | null;
    };
    expect(searchPayload).toEqual({
      data: [{ doc_id: 'e2e-doc-1', title: 'E2E Strategy', doc_type: 'docx' }],
      next: null,
    });

    const content = await fetch(`${apiBaseUrl}/actions/rpc`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key.key}`,
        'x-connection-id': connection.id,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ action: 'get_doc_content', args: { doc_id: 'e2e-doc-1' } }),
    });
    expect(content.status).toBe(200);
    expect(await content.json()).toEqual({ doc_id: 'e2e-doc-1', content: '# Strategy\nE2E content.' });

    const audit = await client.queryAudit(tenantId, { action: 'search_docs' });
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({ connectionId: connection.id, success: true });
  });

  it('executes a write action through the RPC surface, then reads it back (T17c)', async () => {
    const { connections } = await client.listConnections(tenantId);
    const connection = connections[0]!;
    await client.setAllowlist(connection.id, [
      'create_doc',
      'get_doc_content',
      'append_doc_content',
    ]);

    const key = await client.createKey(tenantId, 'actions');
    const rpc = (body: unknown) =>
      fetch(`${apiBaseUrl}/actions/rpc`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${key.key}`,
          'x-connection-id': connection.id,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      });

    const create = await rpc({
      action: 'create_doc',
      args: { title: 'E2E Created', content: 'First line.' },
    });
    expect(create.status).toBe(200);
    const created = (await create.json()) as { doc_id: string; title: string };
    expect(created.title).toBe('E2E Created');

    // The created doc is immediately readable through the read path.
    const read = await rpc({ action: 'get_doc_content', args: { doc_id: created.doc_id } });
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual({ doc_id: created.doc_id, content: 'First line.' });

    const appended = await rpc({
      action: 'append_doc_content',
      args: { doc_id: created.doc_id, content: 'Second line.' },
    });
    expect(appended.status).toBe(200);
    expect(await appended.json()).toEqual({
      doc_id: created.doc_id,
      content: 'First line.\nSecond line.',
    });

    const audit = await client.queryAudit(tenantId, { action: 'create_doc' });
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({ connectionId: connection.id, success: true });
  });

  it('walks the sheet leg: write then read back through the RPC surface, audited (T18a)', async () => {
    const { connections } = await client.listConnections(tenantId);
    const connection = connections[0]!;
    await client.setAllowlist(connection.id, ['write_sheet_cells', 'read_sheet_cells']);

    const key = await client.createKey(tenantId, 'actions');
    const rpc = (body: unknown) =>
      fetch(`${apiBaseUrl}/actions/rpc`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${key.key}`,
          'x-connection-id': connection.id,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      });

    // Write with an explicit sheet name (the sheetId slot takes the NAME
    // directly — no resolution), native types preserved.
    const write = await rpc({
      action: 'write_sheet_cells',
      args: {
        doc_id: 'e2e-wb-1',
        sheet_name: 'Summary',
        range: 'A2:B2',
        values: [['EMEA', 25]],
      },
    });
    expect(write.status).toBe(200);
    expect(await write.json()).toEqual({
      doc_id: 'e2e-wb-1',
      range: 'A2:B2',
      updated_cells: 2,
    });

    // Read back with sheet_name omitted — the first-worksheet resolution
    // path through the composed server.
    const read = await rpc({
      action: 'read_sheet_cells',
      args: { doc_id: 'e2e-wb-1', range: 'A1:B2' },
    });
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual({
      doc_id: 'e2e-wb-1',
      range: 'A1:B2',
      data: [
        ['Region', 'Q1'],
        ['EMEA', 25],
      ],
      next: null,
    });

    const writeAudit = await client.queryAudit(tenantId, { action: 'write_sheet_cells' });
    expect(writeAudit.rows).toHaveLength(1);
    expect(writeAudit.rows[0]).toMatchObject({ connectionId: connection.id, success: true });
    const readAudit = await client.queryAudit(tenantId, { action: 'read_sheet_cells' });
    expect(readAudit.rows).toHaveLength(1);
    expect(readAudit.rows[0]).toMatchObject({ connectionId: connection.id, success: true });
  });
});
