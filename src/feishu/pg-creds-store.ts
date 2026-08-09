import pg from 'pg';
import { decryptValue, encryptValue, isCiphertext } from './crypto.js';
import type { FeishuAppCredentials, FeishuCredsStore } from './creds-store.js';

/**
 * Postgres-backed Feishu credentials read with decryption (issue #15).
 *
 * `setFeishuCreds` (admin API) writes ciphertext, so rows created since #15
 * land encrypted. Legacy rows written before the TokenManager landed are
 * plaintext; they are detected by the missing `v1:` prefix, returned
 * transparently, and re-encrypted in place (best effort) so the plaintext
 * does not linger. v1 has no production rows, so this is a one-time
 * transition path, not a long-lived dual format.
 */
export class PostgresFeishuCredsStore implements FeishuCredsStore {
  constructor(
    private readonly pool: pg.Pool,
    private readonly masterKey: string,
  ) {}

  async get(tenantId: string): Promise<FeishuAppCredentials | undefined> {
    const row = (
      await this.pool.query<{ app_id: string; app_secret: string }>(
        'SELECT app_id, app_secret FROM feishu_credentials WHERE tenant_id = $1',
        [tenantId],
      )
    ).rows[0];
    if (!row) return undefined;

    let appSecret = row.app_secret;
    if (!isCiphertext(appSecret)) {
      // Legacy plaintext row: serve it, then encrypt it back (best effort).
      try {
        await this.pool.query('UPDATE feishu_credentials SET app_secret = $1 WHERE tenant_id = $2', [
          encryptValue(tenantId, appSecret, this.masterKey),
          tenantId,
        ]);
      } catch (err) {
        console.error(`legacy app_secret re-encryption failed for tenant ${tenantId}: ${String(err)}`);
      }
    } else {
      appSecret = decryptValue(tenantId, appSecret, this.masterKey);
    }
    return { appId: row.app_id, appSecret };
  }
}
