import pg from 'pg';
import type { ConnectionStateStore } from './connection-state.js';

/**
 * Marks a connection `auth_expired` in Postgres (the first-class status
 * from the StackOne research amendment). Called by the token lifecycle
 * when a refresh fails with a dead grant; the admin surface and MCP
 * exposure then report the connection as needing re-authorization.
 */
export class PostgresConnectionStateStore implements ConnectionStateStore {
  constructor(private readonly pool: pg.Pool) {}

  async getStatus(connectionId: string): Promise<string | undefined> {
    const row = (
      await this.pool.query<{ status: string }>('SELECT status FROM connections WHERE id = $1', [
        connectionId,
      ])
    ).rows[0];
    return row?.status;
  }

  async markAuthExpired(connectionId: string): Promise<void> {
    await this.pool.query("UPDATE connections SET status = 'auth_expired' WHERE id = $1", [
      connectionId,
    ]);
  }
}
