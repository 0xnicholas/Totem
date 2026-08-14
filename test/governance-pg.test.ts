import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { migrateUp } from '../scripts/migrate.mjs';
import { auditParamHash } from '../src/audit.js';
import { PostgresAdminRepository } from '../src/admin/pg-repo.js';
import { PostgresAllowlistStore, PostgresAuditSink, PostgresDefenderPolicyStore } from '../src/pg-governance.js';
import { createActionExecutor } from '../src/index.js';
import { FakeConnector } from '../src/testing/fake-connector.js';
import { CONNECTION_ACTIONS } from '../src/index.js';
import { DOCS_ACTIONS, MESSAGING_ACTIONS } from '../src/index.js';

/**
 * Governance against Postgres: allowlist reads + audit writes through the
 * real stores, and a full-stack check that executeAction's audit rows are
 * queryable via the T3 admin API (AC-4). DB-gated like the other
 * integration tests; applies migrations and truncates tenants at start
 * and end (leaves the DB as found, issue #27).
 */
const dbUrl = process.env.DATABASE_URL;
const hasDb = Boolean(dbUrl);

describe.runIf(hasDb)('governance stores (Postgres)', () => {
  const pool = new pg.Pool({ connectionString: dbUrl });

  beforeAll(async () => {
    await migrateUp(dbUrl!);
    await pool.query("DELETE FROM tenants WHERE name NOT LIKE 'live-%'");
  });

  afterAll(async () => {
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
      actions: [...DOCS_ACTIONS, ...MESSAGING_ACTIONS, ...CONNECTION_ACTIONS],
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

  it('writes defender scan metadata into audit rows and exposes it via queryAudit (T15)', async () => {
    const sink = new PostgresAuditSink(pool);
    const repo = new PostgresAdminRepository(pool);
    const { tenantId, connectionId } = await seedTenantAndConnection('defender-audit');

    const metadata = {
      reason: 'defender_block',
      tier: 'pattern',
      riskLevel: 'high',
      detections: ['instruction-override'],
    };
    await sink.writeAudit({
      tenantId,
      connectionId,
      userId: null,
      actionName: 'get_doc_content',
      paramHash: auditParamHash({ doc_id: 'doc_1' }),
      source: 'mcp',
      success: false,
      errorCode: 'forbidden',
      durationMs: 5,
      createdAt: new Date().toISOString(),
      metadata,
    });

    const rows = await repo.queryAudit(tenantId, {});
    expect(rows[0]?.metadata).toEqual(metadata);
  });

  it('resolves defender policy from the tenants row, defaulting to observe-first (T15)', async () => {
    const store = new PostgresDefenderPolicyStore(pool);
    const { tenantId } = await seedTenantAndConnection('defender-store');

    // Column defaults: scanning on, blocking off.
    await expect(store.getPolicy(tenantId)).resolves.toEqual({
      enabled: true,
      blockHighRisk: false,
    });

    await pool.query('UPDATE tenants SET defender_block_high_risk = true WHERE id = $1', [
      tenantId,
    ]);
    await expect(store.getPolicy(tenantId)).resolves.toEqual({
      enabled: true,
      blockHighRisk: true,
    });

    // Unknown tenant: safe defaults, never a throw (the boundary must not
    // break scanning on a lookup miss).
    await expect(store.getPolicy('00000000-0000-0000-0000-000000000000')).resolves.toEqual({
      enabled: true,
      blockHighRisk: false,
    });
  });
});
