import pg from 'pg';
import type { StoredTokens, TokenStore } from './token-store.js';

/**
 * Postgres `TokenStore` over the `tokens` table (one row per connection,
 * ciphertext columns). `upsert` is a single atomic statement, so a refresh
 * can never half-write.
 */
export class PostgresTokenStore implements TokenStore {
  constructor(private readonly pool: pg.Pool) {}

  async get(connectionId: string): Promise<StoredTokens | undefined> {
    const row = (
      await this.pool.query<{
        tenant_id: string;
        user_access_token: string;
        refresh_token: string;
        expires_at: Date;
      }>(
        `SELECT tenant_id, user_access_token, refresh_token, expires_at
         FROM tokens WHERE connection_id = $1`,
        [connectionId],
      )
    ).rows[0];
    if (!row) return undefined;
    return {
      tenantId: row.tenant_id,
      connectionId,
      accessTokenCiphertext: row.user_access_token,
      refreshTokenCiphertext: row.refresh_token,
      expiresAt: row.expires_at.toISOString(),
    };
  }

  async upsert(tokens: StoredTokens): Promise<void> {
    await this.pool.query(
      `INSERT INTO tokens (tenant_id, connection_id, user_access_token, refresh_token, expires_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (connection_id) DO UPDATE
         SET user_access_token = EXCLUDED.user_access_token,
             refresh_token = EXCLUDED.refresh_token,
             expires_at = EXCLUDED.expires_at`,
      [
        tokens.tenantId,
        tokens.connectionId,
        tokens.accessTokenCiphertext,
        tokens.refreshTokenCiphertext,
        tokens.expiresAt,
      ],
    );
  }
}
