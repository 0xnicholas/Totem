import pg from 'pg';
import type { ConnectionRecord } from '../executor.js';
import type { MCPKeyStore } from './key-store.js';

/**
 * Postgres-backed MCP key verification. Resolves an enabled actions-scoped
 * key by its SHA-256 hash and records `last_used_at` on every successful
 * authentication (the schema field's only writer in v1 — the admin API
 * never exercises it). Disabled keys and admin-scoped keys are excluded by
 * the WHERE clause, so they authenticate as unknown (401).
 */
export class PostgresMCPKeyStore implements MCPKeyStore {
  constructor(private readonly pool: pg.Pool) {}

  async findKey(keyHash: string): Promise<{ tenantId: string; keyId: string } | undefined> {
    const row = (
      await this.pool.query<{ id: string; tenant_id: string }>(
        `UPDATE api_keys SET last_used_at = now()
         WHERE key_hash = $1 AND scope = 'actions' AND disabled_at IS NULL
         RETURNING id, tenant_id`,
        [keyHash],
      )
    ).rows[0];
    return row ? { tenantId: row.tenant_id, keyId: row.id } : undefined;
  }
}

/**
 * Loads every connection into the executor's in-memory `ConnectionStore`
 * at startup (the store is documented as Postgres-backed "in a later
 * ticket"; v1 connections are created outside the action path). Connections
 * whose connector is not registered are skipped with a warning — a
 * connector added in a later ticket must not take the whole server down.
 */
export async function loadConnections(pool: pg.Pool): Promise<ConnectionRecord[]> {
  const rows = await pool.query<{ id: string; tenant_id: string; connector_id: string }>(
    'SELECT id, tenant_id, connector_id FROM connections',
  );
  return rows.rows.map((row) => ({
    tenantId: row.tenant_id,
    connectionId: row.id,
    connectorId: row.connector_id,
  }));
}
