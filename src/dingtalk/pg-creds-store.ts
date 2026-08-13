import pg from 'pg';
import { decryptValue, encryptValue, isCiphertext } from '../crypto.js';
import type { DingTalkAppCredentials, DingTalkCredsStore } from './creds-store.js';

/**
 * Postgres-backed DingTalk credentials read with decryption (ADR-0004).
 *
 * `setDingTalkCreds` (admin API) writes ciphertext, so rows always land
 * encrypted; the plaintext-detection path mirrors the Feishu store for
 * symmetry (rows written directly to the table would be served
 * transparently and re-encrypted in place, best effort).
 */
export class PostgresDingTalkCredsStore implements DingTalkCredsStore {
  constructor(
    private readonly pool: pg.Pool,
    private readonly masterKey: string,
  ) {}

  async get(tenantId: string): Promise<DingTalkAppCredentials | undefined> {
    const row = (
      await this.pool.query<{ app_key: string; app_secret: string }>(
        'SELECT app_key, app_secret FROM dingtalk_credentials WHERE tenant_id = $1',
        [tenantId],
      )
    ).rows[0];
    if (!row) return undefined;

    let appSecret = row.app_secret;
    if (!isCiphertext(appSecret)) {
      // Unencrypted row: serve it, then encrypt it back (best effort).
      try {
        await this.pool.query(
          'UPDATE dingtalk_credentials SET app_secret = $1 WHERE tenant_id = $2',
          [encryptValue(tenantId, appSecret, this.masterKey), tenantId],
        );
      } catch (err) {
        console.error(`legacy app_secret re-encryption failed for tenant ${tenantId}: ${String(err)}`);
      }
    } else {
      appSecret = decryptValue(tenantId, appSecret, this.masterKey);
    }
    return { appKey: row.app_key, appSecret };
  }
}
