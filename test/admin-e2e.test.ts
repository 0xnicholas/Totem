import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { serve, type ServerType } from '@hono/node-server';
import type { AddressInfo } from 'node:net';
import pg from 'pg';
import { migrateUp } from '../scripts/migrate.mjs';
import { AdminApiClient } from '../src/admin/client.js';
import { PostgresAdminRepository } from '../src/admin/pg-repo.js';
import { createAdminApp } from '../src/admin/server.js';

/**
 * Full-stack test: real HTTP server + Postgres + real HTTP client, covering
 * the ticket's core story (create tenant → issue key → configure → query
 * audit). Runs only when DATABASE_URL is set; applies migrations on a fresh
 * database.
 */
const dbUrl = process.env.DATABASE_URL;
const hasDb = Boolean(dbUrl);

describe.runIf(hasDb)('admin API end to end', () => {
  const pool = new pg.Pool({ connectionString: dbUrl });
  let server: ServerType;
  let baseUrl: string;
  let client: AdminApiClient;

  beforeAll(async () => {
    await migrateUp(dbUrl!);
    await pool.query('TRUNCATE tenants CASCADE');
    const app = createAdminApp({ repo: new PostgresAdminRepository(pool), adminKey: 'e2e-admin-key' });
    server = serve({ fetch: app.fetch, port: 0 });
    await new Promise((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    client = new AdminApiClient({ baseUrl, apiKey: 'e2e-admin-key' });
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    await pool.end();
  });

  it('walks the operator flow: tenant, key, creds, allowlist, suspend, audit', async () => {
    // 1. create a tenant (with the bootstrap admin key)
    const tenant = await client.createTenant('e2e-acme');
    expect(tenant.name).toBe('e2e-acme');

    // 2. issue an admin-scoped key and switch to it — the operator's
    //    credential, authenticated against api_keys (not the env key)
    const issued = await client.createKey(tenant.id, 'admin');
    expect(issued.key.startsWith('tt_dev_')).toBe(true);
    expect(issued.scope).toBe('admin');
    const operator = new AdminApiClient({ baseUrl, apiKey: issued.key });

    // The plaintext is not retrievable again: only its hash is stored.
    const stored = (
      await pool.query<{ key_hash: string }>('SELECT key_hash FROM api_keys WHERE id = $1', [issued.id])
    ).rows[0];
    expect(stored?.key_hash).not.toContain(issued.key);
    expect(stored?.key_hash).toMatch(/^[0-9a-f]{64}$/);

    // 3. configure feishu app credentials
    await operator.setFeishuCreds(tenant.id, 'e2e_app_id', 'e2e_secret');
    const creds = (
      await pool.query<{ app_id: string; app_secret: string }>(
        'SELECT app_id, app_secret FROM feishu_credentials WHERE tenant_id = $1',
        [tenant.id],
      )
    ).rows[0];
    expect(creds).toEqual({ app_id: 'e2e_app_id', app_secret: 'e2e_secret' });

    // 4. set the allowlist on a connection (created by the OAuth flow, T6)
    const connection = (
      await pool.query(
        `INSERT INTO connections (tenant_id, connector_id, name, owner_id)
         VALUES ($1, 'fake', 'e2e-conn', $2) RETURNING id`,
        [tenant.id, tenant.id],
      )
    ).rows[0] as { id: string };
    await operator.setAllowlist(connection.id, ['create_doc', 'read_doc']);
    await operator.suspendConnection(connection.id);

    const allowlist = (
      await pool.query<{ action_name: string }>(
        'SELECT action_name FROM allowlists WHERE connection_id = $1',
        [connection.id],
      )
    ).rows;
    expect(allowlist.map((r) => r.action_name).sort()).toEqual(['create_doc', 'read_doc']);

    const status = (
      await pool.query<{ status: string }>('SELECT status FROM connections WHERE id = $1', [connection.id])
    ).rows[0];
    expect(status?.status).toBe('suspended');

    // 5. query the audit trail with the issued admin key
    const { rows } = await operator.queryAudit(tenant.id, { action: 'admin.allowlist_updated' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ connectionId: connection.id, userId: 'admin', source: 'admin_api' });

    const { rows: all } = await operator.queryAudit(tenant.id, {});
    expect(all.map((r) => r.actionName)).toEqual([
      'admin.connection_suspended',
      'admin.allowlist_updated',
      'admin.feishu_creds_updated',
      'admin.key_issued',
      'admin.tenant_created',
    ]);
  });
});
