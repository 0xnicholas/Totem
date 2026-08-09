import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { migrateDown, migrateUp } from '../scripts/migrate.mjs';

/**
 * Migration integration tests: apply and roll back the real schema on the
 * database in DATABASE_URL. They only run when DATABASE_URL is set — the CI
 * postgres service or a local `docker compose up db`. The final test leaves
 * the database migrated (the state `docker compose up` produces).
 */
const dbUrl = process.env.DATABASE_URL;
const hasDb = Boolean(dbUrl);

describe.runIf(hasDb)('migrations', () => {
  const client = new pg.Client({ connectionString: dbUrl });

  beforeAll(async () => {
    await client.connect();
  });

  afterAll(async () => {
    await client.end();
  });

  async function publicTables(): Promise<string[]> {
    const result = await client.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
    );
    return result.rows.map((row) => row.tablename);
  }

  async function appliedVersions(): Promise<number> {
    const result = await client.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM schema_migrations',
    );
    return result.rows[0]?.n ?? 0;
  }

  it('applies all pending migrations and creates the six tables with tenant_id and foreign keys', async () => {
    await migrateUp(dbUrl!);

    const tables = await publicTables();
    for (const table of ['tenants', 'connections', 'api_keys', 'allowlists', 'audit_logs', 'tokens', 'schema_migrations']) {
      expect(tables, `table ${table}`).toContain(table);
    }

    // tenant_id on every tenant-scoped table.
    for (const table of ['connections', 'api_keys', 'allowlists', 'audit_logs', 'tokens']) {
      const column = await client.query(
        `SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = $1 AND column_name = 'tenant_id'`,
        [table],
      );
      expect(column.rowCount, `tenant_id column on ${table}`).toBe(1);
    }

    // Foreign keys from every tenant-scoped table to tenants.
    for (const table of ['connections', 'api_keys', 'allowlists', 'audit_logs', 'tokens']) {
      const fk = await client.query(
        `SELECT 1 FROM pg_constraint c
         JOIN pg_class cl ON c.conrelid = cl.oid
         JOIN pg_namespace n ON cl.relnamespace = n.oid
         WHERE n.nspname = 'public' AND cl.relname = $1 AND c.contype = 'f'
           AND c.confrelid = 'tenants'::regclass`,
        [table],
      );
      expect(fk.rowCount, `foreign key from ${table} to tenants`).toBeGreaterThan(0);
    }
  });

  it('is a no-op on a second apply', async () => {
    await migrateUp(dbUrl!);
    expect(await appliedVersions()).toBe(1);
  });

  it('rolls back the latest migration', async () => {
    await migrateDown(dbUrl!);
    const tables = await publicTables();
    expect(tables).not.toContain('tenants');
    expect(await appliedVersions()).toBe(0);
  });

  it('rolls back cleanly when nothing is applied, then re-applies', async () => {
    await migrateDown(dbUrl!);
    await migrateUp(dbUrl!);
    const tables = await publicTables();
    expect(tables).toContain('tenants');
    expect(await appliedVersions()).toBe(1);
  });
});
