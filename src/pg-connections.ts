import pg from 'pg';
import type { ConnectionLookup, ConnectionRecord } from './executor.js';

/**
 * Live Postgres-backed connection lookup for the composed server (T6):
 * the OAuth flow creates connections at runtime, so a startup snapshot
 * would never see them. Status is deliberately not filtered — suspension
 * and auth_expired enforcement are execution-layer concerns tracked in
 * later tickets (and the token manager already fails fast for
 * auth_expired).
 */
export class PostgresConnectionStore implements ConnectionLookup {
  constructor(private readonly pool: pg.Pool) {}

  async get(tenantId: string, connectionId: string): Promise<ConnectionRecord | undefined> {
    const row = (
      await this.pool.query<{ connector_id: string }>(
        'SELECT connector_id FROM connections WHERE id = $1 AND tenant_id = $2',
        [connectionId, tenantId],
      )
    ).rows[0];
    return row ? { tenantId, connectionId, connectorId: row.connector_id } : undefined;
  }

  async list(): Promise<ConnectionRecord[]> {
    const rows = await this.pool.query<{ id: string; tenant_id: string; connector_id: string }>(
      'SELECT id, tenant_id, connector_id FROM connections',
    );
    return rows.rows.map((row) => ({
      tenantId: row.tenant_id,
      connectionId: row.id,
      connectorId: row.connector_id,
    }));
  }
}
