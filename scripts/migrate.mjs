/**
 * Minimal migration runner for totem-api.
 *
 * Applies `migrations/<version>_<name>.up.sql` in version order and rolls
 * back with the matching `.down.sql`, tracking applied versions in a
 * `schema_migrations` table. Re-runnable by design: `up` skips applied
 * versions, `down` rolls back the most recently applied one. Each migration
 * runs in its own transaction.
 *
 * Usage:
 *   DATABASE_URL=postgres://... node scripts/migrate.mjs up
 *   DATABASE_URL=postgres://... node scripts/migrate.mjs down
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pg from 'pg';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations/', import.meta.url));
const MIGRATION_FILE = /^(\d+)_[a-z0-9_]+\.(up|down)\.sql$/;

/** A migration version stem, e.g. `001_initial_schema`. */
function stemOf(fileName) {
  return fileName.replace(/\.(up|down)\.sql$/, '');
}

async function listMigrations() {
  const files = await readdir(MIGRATIONS_DIR);
  const byStem = new Map();
  for (const file of files) {
    const match = file.match(MIGRATION_FILE);
    if (!match) continue;
    const stem = stemOf(file);
    const entry = byStem.get(stem) ?? {
      stem,
      version: Number(match[1]),
      up: undefined,
      down: undefined,
    };
    if (file.endsWith('.up.sql')) entry.up = path.join(MIGRATIONS_DIR, file);
    else entry.down = path.join(MIGRATIONS_DIR, file);
    byStem.set(stem, entry);
  }
  const migrations = [...byStem.values()];
  for (const migration of migrations) {
    if (!migration.up || !migration.down) {
      const missing = migration.up ? 'down' : 'up';
      throw new Error(`Migration "${migration.stem}" is missing its ${missing} file`);
    }
  }
  return migrations.sort((a, b) => a.version - b.version || a.stem.localeCompare(b.stem));
}

async function connect(connectionString) {
  const client = new pg.Client({ connectionString });
  await client.connect();
  return client;
}

async function ensureTrackingTable(client) {
  await client.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       version    TEXT PRIMARY KEY,
       applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
     )`,
  );
}

/** Runs `fn` inside a transaction, rolling back on any error. */
async function inTransaction(client, fn) {
  await client.query('BEGIN');
  try {
    const result = await fn();
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

/**
 * Applies all pending migrations. Returns the number applied; a second call
 * on the same database is a no-op (returns 0).
 */
export async function migrateUp(connectionString, { log = console.log } = {}) {
  const client = await connect(connectionString);
  try {
    await ensureTrackingTable(client);
    const applied = new Set(
      (await client.query('SELECT version FROM schema_migrations')).rows.map((r) => r.version),
    );
    const pending = (await listMigrations()).filter((m) => !applied.has(m.stem));
    for (const migration of pending) {
      const sql = await readFile(migration.up, 'utf8');
      log(`Applying ${migration.stem}`);
      try {
        await inTransaction(client, async () => {
          await client.query(sql);
          await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [
            migration.stem,
          ]);
        });
      } catch (err) {
        throw new Error(`Migration ${migration.stem} failed: ${err.message}`, { cause: err });
      }
    }
    if (pending.length === 0) log('No pending migrations');
    return pending.length;
  } finally {
    await client.end();
  }
}

/**
 * Rolls back the most recently applied migration using its `.down.sql`.
 * Returns 1 when a migration was rolled back, 0 when nothing was applied.
 */
export async function migrateDown(connectionString, { log = console.log } = {}) {
  const client = await connect(connectionString);
  try {
    await ensureTrackingTable(client);
    const latest = (
      await client.query('SELECT version FROM schema_migrations ORDER BY applied_at DESC LIMIT 1')
    ).rows[0];
    if (!latest) {
      log('No migrations to roll back');
      return 0;
    }
    const migration = (await listMigrations()).find((m) => m.stem === latest.version);
    if (!migration) {
      throw new Error(`Applied migration "${latest.version}" has no matching down file`);
    }
    const sql = await readFile(migration.down, 'utf8');
    log(`Rolling back ${migration.stem}`);
    try {
      await inTransaction(client, async () => {
        await client.query(sql);
        await client.query('DELETE FROM schema_migrations WHERE version = $1', [migration.stem]);
      });
    } catch (err) {
      throw new Error(`Rollback of ${migration.stem} failed: ${err.message}`, { cause: err });
    }
    return 1;
  } finally {
    await client.end();
  }
}

// CLI entry point.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const command = process.argv[2];
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error('DATABASE_URL is required (e.g. postgres://totem:totem@localhost:5432/totem)');
    process.exit(1);
  }
  const run = command === 'up' ? migrateUp : command === 'down' ? migrateDown : null;
  if (!run) {
    console.error('Usage: node scripts/migrate.mjs <up|down>');
    process.exit(1);
  }
  run(dbUrl).then(
    () => process.exit(0),
    (err) => {
      console.error(err.message);
      process.exit(1);
    },
  );
}
