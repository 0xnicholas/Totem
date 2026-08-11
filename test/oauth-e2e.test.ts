import { serve, type ServerType } from '@hono/node-server';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { migrateUp } from '../scripts/migrate.mjs';
import { AdminApiClient } from '../src/admin/client.js';
import { decryptValue, isCiphertext } from '../src/feishu/crypto.js';
import { createFeishuOAuthClient } from '../src/feishu/oauth.js';
import { PostgresConnectionStateStore } from '../src/feishu/pg-connection-state.js';
import { PostgresFeishuCredsStore } from '../src/feishu/pg-creds-store.js';
import { PostgresTokenStore } from '../src/feishu/pg-token-store.js';
import { TokenManager } from '../src/feishu/token-manager.js';
import { composeServer } from '../src/server/compose.js';
import { MockFeishuServer } from '../src/testing/mock-feishu-server.js';

/**
 * Full-stack T6: the composed server (exactly the production wiring —
 * Postgres stores, real crypto, real flow) against the mock Feishu server,
 * driven with the real admin client + browser-style callback fetch.
 * Covers AC-1 (flow → connection), AC-2 (encrypted tokens at rest, never
 * logged), AC-3 (automatic refresh), AC-4 (auth_expired marking), AC-6
 * (connection auth state via totemctl surface) and issue #15 (app_secret
 * ciphertext).
 */
const dbUrl = process.env.DATABASE_URL;
const hasDb = Boolean(dbUrl);

describe.runIf(hasDb)('OAuth flow end to end (Postgres)', () => {
  const pool = new pg.Pool({ connectionString: dbUrl });
  const MASTER_KEY = 'e2e-master-key-0123456789abcdef0123456789abcdef';
  const ADMIN_KEY = 'e2e-admin-key';
  const REDIRECT_URI = 'https://totem.example.com/oauth/callback/feishu';

  let feishu: ServerType;
  let feishuBaseUrl: string;
  let mock: MockFeishuServer;
  let api: ServerType;
  let apiBaseUrl: string;
  let client: AdminApiClient;
  let tenantId: string;

  beforeAll(async () => {
    await migrateUp(dbUrl!);
    await pool.query("DELETE FROM tenants WHERE name NOT LIKE 'live-%'");

    mock = new MockFeishuServer({
      appId: 'e2e_app_id',
      appSecret: 'e2e_app_secret',
      // 4 minutes: inside the TokenManager's 5-minute refresh window, so
      // the first access-token read refreshes immediately.
      accessTokenTtlMs: 4 * 60 * 1000,
    });
    feishu = serve({ fetch: mock.app.fetch, port: 0 });
    await new Promise((resolve) => feishu.once('listening', resolve));
    feishuBaseUrl = `http://127.0.0.1:${(feishu.address() as AddressInfo).port}`;

    const app = composeServer(pool, {
      masterKey: MASTER_KEY,
      adminKey: ADMIN_KEY,
      feishuBaseUrl,
    });
    api = serve({ fetch: app.fetch, port: 0 });
    await new Promise((resolve) => api.once('listening', resolve));
    apiBaseUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
    client = new AdminApiClient({ baseUrl: apiBaseUrl, apiKey: ADMIN_KEY });

    tenantId = (await client.createTenant('e2e-oauth')).id;
  });

  afterAll(async () => {
    if (api) await new Promise((resolve) => api.close(resolve));
    if (feishu) await new Promise((resolve) => feishu.close(resolve));
    // Leave the database as found: truncate fixtures so repeated runs
    // against a dev DB never accumulate leftover tenants (issue #27).
    try {
      await pool.query("DELETE FROM tenants WHERE name NOT LIKE 'live-%'");
    } catch {
      // beforeAll may have failed (e.g. an unreachable database); never
      // mask the original error.
    }
    await pool.end();
  });

  it('stores the app_secret as ciphertext, decryptable only with the tenant key (#15)', async () => {
    await client.setFeishuCreds(tenantId, 'e2e_app_id', 'e2e_app_secret');
    const row = (
      await pool.query<{ app_secret: string }>(
        'SELECT app_secret FROM feishu_credentials WHERE tenant_id = $1',
        [tenantId],
      )
    ).rows[0];
    expect(row?.app_secret).not.toContain('e2e_app_secret');
    expect(isCiphertext(row?.app_secret ?? '')).toBe(true);
    expect(decryptValue(tenantId, row!.app_secret, MASTER_KEY)).toBe('e2e_app_secret');
  });

  it('re-encrypts a legacy plaintext app_secret lazily on read', async () => {
    // A dedicated tenant whose creds row simulates a pre-#15 write.
    const legacyTenant = (
      await pool.query("INSERT INTO tenants (name) VALUES ('legacy-creds') RETURNING id")
    ).rows[0] as { id: string };
    await pool.query(
      'INSERT INTO feishu_credentials (tenant_id, app_id, app_secret) VALUES ($1, $2, $3)',
      [legacyTenant.id, 'legacy_app_id', 'legacy-plaintext-secret'],
    );

    // The creds store serves the plaintext transparently...
    const store = new PostgresFeishuCredsStore(pool, MASTER_KEY);
    await expect(store.get(legacyTenant.id)).resolves.toEqual({
      appId: 'legacy_app_id',
      appSecret: 'legacy-plaintext-secret',
    });
    // ...and the row is now ciphertext.
    const row = (
      await pool.query<{ app_secret: string }>(
        'SELECT app_secret FROM feishu_credentials WHERE tenant_id = $1',
        [legacyTenant.id],
      )
    ).rows[0];
    expect(isCiphertext(row!.app_secret)).toBe(true);
    expect(decryptValue(legacyTenant.id, row!.app_secret, MASTER_KEY)).toBe(
      'legacy-plaintext-secret',
    );
  });

  it('walks the OAuth flow: start → authorize → callback → connection + encrypted tokens', async () => {
    const { authorizationUrl } = await client.startOAuth(tenantId, REDIRECT_URI);

    // The user authorizes: follow the mock's authorize redirect manually.
    const authorize = await fetch(authorizationUrl, { redirect: 'manual' });
    const callback = new URL(authorize.headers.get('location')!);
    const code = callback.searchParams.get('code')!;
    const state = callback.searchParams.get('state')!;

    const callbackResponse = await fetch(`${apiBaseUrl}${callback.pathname}?code=${code}&state=${state}`);
    expect(callbackResponse.status).toBe(200);

    const { connections } = await client.listConnections(tenantId);
    expect(connections).toHaveLength(1);
    const connection = connections[0]!;
    expect(connection).toMatchObject({
      connectorId: 'feishu_docs',
      status: 'active',
      ownerId: tenantId,
      oauthRedirectUri: REDIRECT_URI,
    });

    const tokenRow = (
      await pool.query<{ user_access_token: string; refresh_token: string; expires_at: Date }>(
        'SELECT user_access_token, refresh_token, expires_at FROM tokens WHERE connection_id = $1',
        [connection.id],
      )
    ).rows[0];
    expect(tokenRow).toBeDefined();
    expect(isCiphertext(tokenRow!.user_access_token)).toBe(true);
    expect(tokenRow!.user_access_token).not.toContain('mock_access');
    expect(decryptValue(tenantId, tokenRow!.user_access_token, MASTER_KEY)).toMatch(/^mock_access_/);
    expect(decryptValue(tenantId, tokenRow!.refresh_token, MASTER_KEY)).toMatch(/^mock_refresh_/);

    const audit = await client.queryAudit(tenantId, { action: 'admin.connection_created' });
    expect(audit.rows).toHaveLength(1);
  });

  it('refreshes automatically inside the expiry window and marks auth_expired on revocation', async () => {
    const { connections } = await client.listConnections(tenantId);
    const connection = connections[0]!;

    const tokenManager = new TokenManager({
      tokenStore: new PostgresTokenStore(pool),
      credsStore: new PostgresFeishuCredsStore(pool, MASTER_KEY),
      oauth: createFeishuOAuthClient(feishuBaseUrl),
      connectionState: new PostgresConnectionStateStore(pool),
      masterKey: MASTER_KEY,
    });

    // Tokens are inside the 5-minute window (4-minute TTL): the first read
    // refreshes immediately, exactly once, and returns a working token.
    const token = await tokenManager.getValidAccessToken(connection.id);
    expect(token).toMatch(/^mock_access_/);
    expect(mock.refreshRequestCount).toBe(1);

    // The refreshed pair replaced the stored one.
    const refreshedRow = (
      await pool.query<{ user_access_token: string }>(
        'SELECT user_access_token FROM tokens WHERE connection_id = $1',
        [connection.id],
      )
    ).rows[0];
    expect(refreshedRow!.user_access_token).not.toContain(token);

    // Revoke the new refresh token: the next refresh fails, the connection
    // is marked auth_expired, and later calls fail fast.
    const stored = (
      await pool.query<{ refresh_token: string }>(
        'SELECT refresh_token FROM tokens WHERE connection_id = $1',
        [connection.id],
      )
    ).rows[0];
    mock.revokeRefreshToken(decryptValue(tenantId, stored!.refresh_token, MASTER_KEY));

    const refreshedCount = mock.refreshRequestCount;
    await expect(tokenManager.getValidAccessToken(connection.id)).rejects.toMatchObject({
      code: 'auth_expired',
    });
    await expect(tokenManager.getValidAccessToken(connection.id)).rejects.toMatchObject({
      code: 'auth_expired',
    });
    expect(mock.refreshRequestCount).toBe(refreshedCount + 1); // fail fast after marking

    const { connections: after } = await client.listConnections(tenantId);
    expect(after[0]?.status).toBe('auth_expired');
  });

  it('executes MCP tools on an OAuth-created connection (whole stack)', async () => {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StreamableHTTPClientTransport } = await import(
      '@modelcontextprotocol/sdk/client/streamableHttp.js'
    );

    // A fresh connection: the revocation test above leaves its connection
    // auth_expired by design, which would make this test's call fail fast.
    mock.seedDocs([
      {
        doc_id: 'e2e-doc',
        title: 'E2E Strategy',
        content: '# Strategy\n\nThe unified action layer.',
        owner_id: 'user-e2e',
        doc_type: 'docx',
        edited_at: '2026-03-01T10:00:00.000Z',
      },
    ]);
    mock.seedSheet('e2e-sheet', 'E2E Tracker', 'Data', [
      ['Region', 'Q1'],
      ['APAC', 10],
    ]);
    mock.seedBitable('e2e-bit', 'E2E Customers', [
      { name: 'Leads', records: [{ record_id: 'rec_e2e_1', fields: { name: 'Ada' } }] },
    ]);
    const { authorizationUrl } = await client.startOAuth(tenantId, REDIRECT_URI);
    const authorize = await fetch(authorizationUrl, { redirect: 'manual' });
    const callback = new URL(authorize.headers.get('location')!);
    await fetch(
      `${apiBaseUrl}${callback.pathname}?code=${callback.searchParams.get('code')}&state=${callback.searchParams.get('state')}`,
    );
    const { connections } = await client.listConnections(tenantId);
    const connection = connections.find((c) => c.status === 'active')!;
    await client.setAllowlist(connection.id, [
      'create_doc',
      'search_docs',
      'get_doc_content',
      'get_doc_metadata',
      'append_doc_content',
      'rename_doc',
      'move_doc',
      'export_doc',
      'read_sheet_cells',
      'write_sheet_cells',
      'read_bitable_records',
      'write_bitable_records',
    ]);
    const issued = await client.createKey(tenantId, 'actions');

    const mcpClient = new Client({ name: 'e2e', version: '0.0.0' }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL(`${apiBaseUrl}/mcp`), {
      requestInit: {
        headers: {
          authorization: `Bearer ${issued.key}`,
          'x-connection-id': connection.id,
        },
      },
    });
    await mcpClient.connect(transport);
    try {
      // The real Feishu connector exposes its full v1 action set.
      const { tools } = await mcpClient.listTools();
      expect(tools.map((t) => t.name)).toEqual([
        'create_doc',
        'search_docs',
        'get_doc_content',
        'get_doc_metadata',
        'append_doc_content',
        'rename_doc',
        'move_doc',
        'export_doc',
        'read_sheet_cells',
        'write_sheet_cells',
        'read_bitable_records',
        'write_bitable_records',
      ]);

      // The call only succeeds if the TokenManager retrieved a valid token
      // for the OAuth-created connection (encrypted store → refresh path)
      // and the real connector's Feishu call is accepted by the mock.
      const searched = await mcpClient.callTool({
        name: 'search_docs',
        arguments: { query: 'strategy' },
      });
      expect(searched.isError).toBeUndefined();
      expect(searched.structuredContent).toMatchObject({
        data: [{ doc_id: 'e2e-doc', title: 'E2E Strategy' }],
        next: null,
      });

      const content = await mcpClient.callTool({
        name: 'get_doc_content',
        arguments: { doc_id: 'e2e-doc' },
      });
      expect(content.structuredContent).toMatchObject({ doc_id: 'e2e-doc' });

      // The write lifecycle (T8) through MCP: create → append → rename →
      // move, each routed through the connector against the mock.
      const created = await mcpClient.callTool({
        name: 'create_doc',
        arguments: { title: 'E2E Written', content: 'Opening line.' },
      });
      expect(created.isError).toBeUndefined();
      const writtenId = (created.structuredContent as { doc_id: string }).doc_id;
      expect(writtenId).toBeTruthy();

      const appended = await mcpClient.callTool({
        name: 'append_doc_content',
        arguments: { doc_id: writtenId, content: 'Closing line.' },
      });
      expect(appended.structuredContent).toMatchObject({
        doc_id: writtenId,
        content: 'Opening line.\nClosing line.',
      });

      const renamed = await mcpClient.callTool({
        name: 'rename_doc',
        arguments: { doc_id: writtenId, new_title: 'E2E Renamed' },
      });
      expect(renamed.structuredContent).toMatchObject({ doc_id: writtenId, title: 'E2E Renamed' });

      const moved = await mcpClient.callTool({
        name: 'move_doc',
        arguments: { doc_id: writtenId, folder_id: 'e2e-folder' },
      });
      expect(moved.structuredContent).toMatchObject({
        doc_id: writtenId,
        folder_id: 'e2e-folder',
      });

      const finalRead = await mcpClient.callTool({
        name: 'get_doc_metadata',
        arguments: { doc_id: writtenId },
      });
      expect(finalRead.structuredContent).toMatchObject({
        doc_id: writtenId,
        title: 'E2E Renamed',
      });

      // The advanced set (T9) through MCP: export, sheet cells, bitable.
      const exported = await mcpClient.callTool({
        name: 'export_doc',
        arguments: { doc_id: 'e2e-doc', format: 'docx' },
      });
      expect(exported.isError).toBeUndefined();
      expect(exported.structuredContent).toMatchObject({ doc_id: 'e2e-doc', format: 'docx' });
      expect((exported.structuredContent as { artifact_id: string }).artifact_id).toBeTruthy();

      const sheetRead = await mcpClient.callTool({
        name: 'read_sheet_cells',
        arguments: { doc_id: 'e2e-sheet', sheet_name: 'Data', range: 'A1:B2' },
      });
      expect(sheetRead.structuredContent).toMatchObject({
        data: [
          ['Region', 'Q1'],
          ['APAC', 10],
        ],
        next: null,
      });

      const sheetWrite = await mcpClient.callTool({
        name: 'write_sheet_cells',
        arguments: { doc_id: 'e2e-sheet', sheet_name: 'Data', range: 'B2', values: [[42]] },
      });
      expect(sheetWrite.structuredContent).toMatchObject({ updated_cells: 1 });

      const bitableRead = await mcpClient.callTool({
        name: 'read_bitable_records',
        arguments: { doc_id: 'e2e-bit', table_name: 'Leads' },
      });
      expect(bitableRead.structuredContent).toMatchObject({
        data: [{ record_id: 'rec_e2e_1', fields: { name: 'Ada' } }],
        next: null,
      });

      const bitableWrite = await mcpClient.callTool({
        name: 'write_bitable_records',
        arguments: { doc_id: 'e2e-bit', table_name: 'Leads', fields: { name: 'Grace' } },
      });
      expect(bitableWrite.isError).toBeUndefined();
      expect((bitableWrite.structuredContent as { record_id: string }).record_id).toBeTruthy();
    } finally {
      await mcpClient.close();
    }
  });

  it('re-authorizes an auth_expired connection in place', async () => {
    const { connections: before } = await client.listConnections(tenantId);
    const connection = before[0]!; // the revoked connection from the refresh test

    // Re-run the flow targeting the existing connection.
    const { authorizationUrl } = await client.startOAuth(tenantId, REDIRECT_URI, connection.id);
    const authorize = await fetch(authorizationUrl, { redirect: 'manual' });
    const callback = new URL(authorize.headers.get('location')!);
    const callbackResponse = await fetch(
      `${apiBaseUrl}${callback.pathname}?code=${callback.searchParams.get('code')}&state=${callback.searchParams.get('state')}`,
    );
    expect(callbackResponse.status).toBe(200);

    const { connections: after } = await client.listConnections(tenantId);
    expect(after).toHaveLength(before.length); // no new connection
    expect(after.find((c) => c.id === connection.id)?.status).toBe('active');
  });
});
