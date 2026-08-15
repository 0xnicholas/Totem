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
      await this.pool.query<{ app_key: string; app_secret: string; robot_code: string | null }>(
        'SELECT app_key, app_secret, robot_code FROM dingtalk_credentials WHERE tenant_id = $1',
        [tenantId],
      )
    ).rows[0];
    if (!row) return undefined;

    const appSecret = await this.decryptSecret(tenantId, 'app_secret', row.app_secret);
    return {
      appKey: row.app_key,
      appSecret,
      // robot_code is NULL until the tenant syncs it (#49); ciphertext at
      // rest like app_secret, decrypted the same way.
      ...(row.robot_code !== null
        ? { robotCode: await this.decryptSecret(tenantId, 'robot_code', row.robot_code) }
        : {}),
    };
  }

  /**
   * One secret column, one policy: ciphertext decrypts; a legacy plaintext
   * row is served and re-encrypted in place (best effort — a failed
   * re-encrypt never masks the read).
   */
  private async decryptSecret(tenantId: string, column: string, stored: string): Promise<string> {
    if (!isCiphertext(stored)) {
      try {
        await this.pool.query(
          `UPDATE dingtalk_credentials SET ${column} = $1 WHERE tenant_id = $2`,
          [encryptValue(tenantId, stored, this.masterKey), tenantId],
        );
      } catch (err) {
        console.error(`legacy ${column} re-encryption failed for tenant ${tenantId}: ${String(err)}`);
      }
      return stored;
    }
    return decryptValue(tenantId, stored, this.masterKey);
  }
}
