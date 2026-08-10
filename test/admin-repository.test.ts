import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { migrateUp } from '../scripts/migrate.mjs';
import { NotFoundError } from '../src/admin/repo.js';
import { auditParamHash } from '../src/audit.js';
import { PostgresAdminRepository } from '../src/admin/pg-repo.js';

/**
 * Postgres admin repository integration tests. Run only when DATABASE_URL
 * is set; applies migrations on a fresh database and truncates all rows at
 * start — the database is treated as scratch space.
 */
const dbUrl = process.env.DATABASE_URL;
const hasDb = Boolean(dbUrl);

describe.runIf(hasDb)('PostgresAdminRepository', () => {
  const pool = new pg.Pool({ connectionString: dbUrl });
  const repo = new PostgresAdminRepository(pool);

  beforeAll(async () => {
    await migrateUp(dbUrl!);
    await pool.query('TRUNCATE tenants CASCADE');
  });

  afterAll(async () => {
    await pool.end();
  });

  it('creates and reads back a tenant', async () => {
    const tenant = await repo.createTenant('repo-tenant');
    expect(tenant.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(await repo.getTenant(tenant.id)).toMatchObject({ name: 'repo-tenant' });
    expect(await repo.getTenant('00000000-0000-0000-0000-000000000000')).toBeUndefined();
  });

  it('stores only the key hash and supports disabling', async () => {
    const tenant = await repo.createTenant('keys-tenant');
    const key = await repo.createApiKey(tenant.id, 'actions', {
      prefix: 'tt_dev_',
      keyHash: 'deadbeef',
    });

    expect(key.keyHash).toBe('deadbeef');
    expect(key.scope).toBe('actions');
    expect(await repo.getApiKey(tenant.id, key.id)).toMatchObject({ keyHash: 'deadbeef' });
    // Tenant isolation: another tenant cannot see the key.
    const other = await repo.createTenant('other-tenant');
    expect(await repo.getApiKey(other.id, key.id)).toBeUndefined();

    expect(await repo.disableApiKey(tenant.id, key.id)).toBe(true);
    expect(await repo.disableApiKey(tenant.id, key.id)).toBe(false);
    expect(await repo.disableApiKey(tenant.id, '00000000-0000-0000-0000-000000000000')).toBe(false);
  });

  it('upserts feishu credentials and 404s on unknown tenants', async () => {
    const tenant = await repo.createTenant('creds-tenant');
    await repo.setFeishuCreds(tenant.id, { appId: 'app-1', appSecret: 'secret-1' });
    await repo.setFeishuCreds(tenant.id, { appId: 'app-2', appSecret: 'secret-2' });

    const row = (
      await pool.query<{ app_id: string; app_secret: string }>(
        'SELECT app_id, app_secret FROM feishu_credentials WHERE tenant_id = $1',
        [tenant.id],
      )
    ).rows[0];
    expect(row).toMatchObject({ app_id: 'app-2', app_secret: 'secret-2' });

    await expect(
      repo.setFeishuCreds('00000000-0000-0000-0000-000000000000', { appId: 'a', appSecret: 'b' }),
    ).rejects.toThrow(NotFoundError);
  });

  it('replaces the allowlist and audits the change', async () => {
    const tenant = await repo.createTenant('allowlist-tenant');
    const connection = await seedConnection(pool, tenant.id, 'conn-repo-1');

    await repo.setAllowlist(connection.id, ['create_doc', 'get_doc_content']);
    await repo.setAllowlist(connection.id, ['search_docs']);

    const rows = (
      await pool.query<{ action_name: string }>(
        'SELECT action_name FROM allowlists WHERE connection_id = $1 ORDER BY action_name', [
        connection.id,
      ])
    ).rows;
    expect(rows).toEqual([{ action_name: 'search_docs' }]);

    const audits = await repo.queryAudit(tenant.id, { action: 'admin.allowlist_updated' });
    expect(audits[0]).toMatchObject({
      connectionId: connection.id,
      userId: 'admin',
      source: 'admin_api',
      success: true,
    });
    expect(audits[0]?.paramHash).toBe(
      auditParamHash({ connectionId: connection.id, actions: ['search_docs'] }),
    );

    await expect(repo.setAllowlist('00000000-0000-0000-0000-000000000000', [])).rejects.toThrow(
      NotFoundError,
    );
  });

  it('suspends and resumes connections', async () => {
    const tenant = await repo.createTenant('suspend-tenant');
    const connection = await seedConnection(pool, tenant.id, 'conn-repo-2');

    await repo.suspendConnection(connection.id, true);
    const suspended = (
      await pool.query<{ status: string }>('SELECT status FROM connections WHERE id = $1', [connection.id])
    ).rows[0];
    expect(suspended?.status).toBe('suspended');

    await repo.suspendConnection(connection.id, false);
    const resumed = (
      await pool.query<{ status: string }>('SELECT status FROM connections WHERE id = $1', [connection.id])
    ).rows[0];
    expect(resumed?.status).toBe('active');

    await expect(
      repo.suspendConnection('00000000-0000-0000-0000-000000000000', true),
    ).rejects.toThrow(NotFoundError);
  });

  it('queries audit rows with filters and tenant isolation', async () => {
    const tenant = await repo.createTenant('audit-tenant');
    const other = await repo.createTenant('audit-other');
    await repo.createApiKey(tenant.id, 'actions', { prefix: 'tt_dev_', keyHash: 'h1' });
    const connection = await seedConnection(pool, tenant.id, 'conn-repo-3');
    await repo.setAllowlist(connection.id, ['create_doc']);
    await repo.suspendConnection(connection.id, true);
    await repo.createApiKey(other.id, 'admin', { prefix: 'tt_dev_', keyHash: 'h2' });

    const all = await repo.queryAudit(tenant.id, {});
    expect(all.map((r) => r.actionName)).toEqual([
      'admin.connection_suspended',
      'admin.allowlist_updated',
      'admin.key_issued',
      'admin.tenant_created',
    ]);

    const byAction = await repo.queryAudit(tenant.id, { action: 'admin.key_issued' });
    expect(byAction).toHaveLength(1);

    const byUser = await repo.queryAudit(tenant.id, { userId: 'admin' });
    expect(byUser.length).toBeGreaterThanOrEqual(4);

    const bySource = await repo.queryAudit(tenant.id, { source: 'mcp' });
    expect(bySource).toHaveLength(0);

    const bySuccess = await repo.queryAudit(tenant.id, { success: true });
    expect(bySuccess.length).toBeGreaterThanOrEqual(4);

    const since = await repo.queryAudit(tenant.id, { since: '2099-01-01T00:00:00Z' });
    expect(since).toHaveLength(0);

    // Tenant isolation: the other tenant's key_issued row is not visible.
    const otherRows = await repo.queryAudit(other.id, { action: 'admin.key_issued' });
    expect(otherRows).toHaveLength(1);
    expect(otherRows[0]?.tenantId).toBe(other.id);

    await expect(repo.queryAudit('00000000-0000-0000-0000-000000000000', {})).rejects.toThrow(
      NotFoundError,
    );
  });

  it('reads, updates and audits the tenant audit policy (T11)', async () => {
    const tenant = await repo.createTenant('policy-tenant');

    expect(await repo.getAuditPolicy(tenant.id)).toEqual({
      retentionDays: 90,
      errorOnly: false,
      captureBody: false,
    });

    const updated = await repo.setAuditPolicy(tenant.id, { retentionDays: 7, errorOnly: true });
    expect(updated).toEqual({ retentionDays: 7, errorOnly: true, captureBody: false });

    // Partial updates keep omitted fields.
    const again = await repo.setAuditPolicy(tenant.id, { captureBody: true });
    expect(again).toEqual({ retentionDays: 7, errorOnly: true, captureBody: true });

    const audits = await repo.queryAudit(tenant.id, { action: 'admin.audit_policy_updated' });
    expect(audits).toHaveLength(2);

    await expect(repo.getAuditPolicy('00000000-0000-0000-0000-000000000000')).rejects.toThrow(
      NotFoundError,
    );
    await expect(
      repo.setAuditPolicy('00000000-0000-0000-0000-000000000000', { errorOnly: true }),
    ).rejects.toThrow(NotFoundError);
  });

  it('purges only the tenant\'s rows past its retention window, audited (T11)', async () => {
    const tenant = await repo.createTenant('purge-tenant');
    const other = await repo.createTenant('purge-other');
    await pool.query(
      `INSERT INTO audit_logs (tenant_id, action_name, param_hash, source, success, duration_ms, created_at)
       VALUES ($1, 'admin.key_issued', 'h', 'admin_api', true, 0, now() - interval '30 days'),
              ($1, 'admin.key_issued', 'h', 'admin_api', true, 0, now() - interval '2 days'),
              ($2, 'admin.key_issued', 'h', 'admin_api', true, 0, now() - interval '30 days')`,
      [tenant.id, other.id],
    );
    await repo.setAuditPolicy(tenant.id, { retentionDays: 7 });

    // Only the tenant's 30-day-old row is past a 7-day window.
    const { deleted } = await repo.purgeAudit(tenant.id);
    expect(deleted).toBe(1);

    const remaining = await pool.query<{ tenant_id: string; action_name: string }>(
      'SELECT tenant_id, action_name FROM audit_logs WHERE tenant_id = ANY($1)',
      [[tenant.id, other.id]],
    );
    // The tenant's 30-day key_issued row is gone; its 2-day row, the
    // policy-update and purge rows, and the other tenant's untouched rows
    // all survive.
    expect(remaining.rows.map((r) => `${r.tenant_id}:${r.action_name}`).sort()).toEqual(
      [
        `${tenant.id}:admin.audit_policy_updated`,
        `${tenant.id}:admin.audit_purged`,
        `${tenant.id}:admin.key_issued`,
        `${tenant.id}:admin.tenant_created`,
        `${other.id}:admin.key_issued`,
        `${other.id}:admin.tenant_created`,
      ].sort(),
    );

    const purges = await repo.queryAudit(tenant.id, { action: 'admin.audit_purged' });
    expect(purges).toHaveLength(1);

    await expect(
      repo.purgeAudit('00000000-0000-0000-0000-000000000000'),
    ).rejects.toThrow(NotFoundError);
  });
});

async function seedConnection(
  pool: pg.Pool,
  tenantId: string,
  name: string,
): Promise<{ id: string; tenant_id: string }> {
  const row = (
    await pool.query<{ id: string; tenant_id: string }>(
      `INSERT INTO connections (tenant_id, connector_id, name, owner_id)
       VALUES ($1, 'fake', $2, $3) RETURNING id, tenant_id`,
      [tenantId, name, tenantId],
    )
  ).rows[0];
  return row as { id: string; tenant_id: string };
}
