import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { migrateUp } from '../scripts/migrate.mjs';
import { auditParamHash } from '../src/audit.js';
import { PostgresAdminRepository } from '../src/admin/pg-repo.js';
import { PostgresAllowlistStore, PostgresAuditSink } from '../src/pg-governance.js';
import { createActionExecutor } from '../src/index.js';
import { FakeConnector } from '../src/testing/fake-connector.js';
import { CONNECTION_ACTIONS } from '../src/index.js';
import { DOCS_ACTIONS } from '../src/index.js';

/**
 * Governance against Postgres: allowlist reads + audit writes through the
 * real stores, and a full-stack check that executeAction's audit rows are
 * queryable via the T3 admin API (AC-4). DB-gated like the other
 * integration tests; applies migrations and truncates at start.
 */
const dbUrl = process.env.DATABASE_URL;
const hasDb = Boolean(dbUrl);

describe.runIf(hasDb)('governance stores (Postgres)', () => {
  const pool = new pg.Pool({ connectionString: dbUrl });

  beforeAll(async () => {
    await migrateUp(dbUrl!);
    await pool.query('TRUNCATE tenants CASCADE');
  });

  afterAll(async () => {
    await pool.end();
  });

  async function seedTenantAndConnection(
    name: string,
  ): Promise<{ tenantId: string; connectionId: string }> {
    const tenant = (
      await pool.query('INSERT INTO tenants (name) VALUES ($1) RETURNING id', [name])
    ).rows[0] as { id: string };
    const connection = (
      await pool.query(
        `INSERT INTO connections (tenant_id, connector_id, name, owner_id)
         VALUES ($1, 'fake', $2, $3) RETURNING id`,
        [tenant.id, `${name}-conn`, tenant.id],
      )
    ).rows[0] as { id: string };
    return { tenantId: tenant.id, connectionId: connection.id };
  }

  it('reads allowlist rows per (tenant, connection) and is empty when unset', async () => {
    const store = new PostgresAllowlistStore(pool);
    const a = await seedTenantAndConnection('al-a');
    const b = await seedTenantAndConnection('al-b');

    await pool.query(
      `INSERT INTO allowlists (tenant_id, connection_id, action_name) VALUES ($1, $2, 'create_doc'), ($1, $2, 'get_doc_content')`,
      [a.tenantId, a.connectionId],
    );

    await expect(store.getAllowedActions(a.tenantId, a.connectionId)).resolves.toEqual([
      'create_doc',
      'get_doc_content',
    ]);
    await expect(store.getAllowedActions(b.tenantId, b.connectionId)).resolves.toEqual([]);
  });

  it('writes audit rows that the admin repository can query (AC-4)', async () => {
    const sink = new PostgresAuditSink(pool);
    const repo = new PostgresAdminRepository(pool);
    const { tenantId, connectionId } = await seedTenantAndConnection('audit-a');
    const args = { title: 'governed' };

    const executor = createActionExecutor({
      actions: [...DOCS_ACTIONS, ...CONNECTION_ACTIONS],
      connectors: [new FakeConnector()],
      connections: [{ tenantId, connectionId, connectorId: 'fake' }],
      allowlists: new PostgresAllowlistStore(pool),
      audit: sink,
    });
    // The allowlist is empty → fail-closed.
    const denied = await executor.executeAction(tenantId, connectionId, 'create_doc', args);
    expect(denied).toMatchObject({ ok: false, error: { code: 'forbidden' } });

    await pool.query(
      `INSERT INTO allowlists (tenant_id, connection_id, action_name) VALUES ($1, $2, 'create_doc')`,
      [tenantId, connectionId],
    );
    const allowed = await executor.executeAction(tenantId, connectionId, 'create_doc', args);
    expect(allowed).toMatchObject({ ok: true });

    const rows = await repo.queryAudit(tenantId, {});
    expect(rows.map((r) => r.actionName)).toEqual(['create_doc', 'create_doc']);
    expect(rows.map((r) => r.errorCode)).toEqual([null, 'forbidden']);
    expect(rows.map((r) => r.source)).toEqual(['mcp', 'mcp']);
    expect(rows.map((r) => r.connectionId)).toEqual([connectionId, connectionId]);
    expect(rows.map((r) => r.paramHash)).toEqual([
      auditParamHash(args),
      auditParamHash(args),
    ]);
    expect(rows[0]?.success).toBe(true);
    expect(rows[1]?.success).toBe(false);
  });
});
