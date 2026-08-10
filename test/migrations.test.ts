import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { listMigrations, migrateDown, migrateUp } from '../scripts/migrate.mjs';

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

  it('applies all pending migrations and creates every migration table with tenant_id and foreign keys', async () => {
    await migrateUp(dbUrl!);

    const tables = await publicTables();
    for (const table of ['tenants', 'connections', 'api_keys', 'allowlists', 'audit_logs', 'tokens', 'feishu_credentials', 'schema_migrations']) {
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
    expect(await appliedVersions()).toBe((await listMigrations()).length);
  });

  it('rolls back the latest migrations (004 defender, then 003) and keeps the rest', async () => {
    await migrateDown(dbUrl!); // 004: drops the defender columns + audit metadata
    expect(await appliedVersions()).toBe((await listMigrations()).length - 1);
    const stillThere = await publicTables();
    expect(stillThere).toContain('feishu_credentials');

    await migrateDown(dbUrl!); // 003: comment-only, no structural change
    expect(await appliedVersions()).toBe((await listMigrations()).length - 2);
    const tables = await publicTables();
    expect(tables).toContain('feishu_credentials');
    expect(tables).toContain('tenants');
  });

  it('rolls back cleanly when nothing is applied, then re-applies', async () => {
    await migrateDown(dbUrl!);
    await migrateUp(dbUrl!);
    const tables = await publicTables();
    expect(tables).toContain('feishu_credentials');
    expect(await appliedVersions()).toBe((await listMigrations()).length);
  });
});
