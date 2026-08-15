import pg from 'pg';
import { decryptValue, encryptValue, isCiphertext } from '../crypto.js';
import type { WeComAppCredentials, WeComCredsStore } from './creds-store.js';

/**
 * Postgres-backed WeCom credentials read with decryption (ADR-0004, same
 * policy as the Feishu/DingTalk stores): `setWecomCreds` (admin API)
 * writes ciphertext, so rows always land encrypted; a row written
 * directly to the table (legacy plaintext) is served transparently and
 * re-encrypted in place, best effort.
 */
export class PostgresWeComCredsStore implements WeComCredsStore {
  constructor(
    private readonly pool: pg.Pool,
    private readonly masterKey: string,
  ) {}

  async get(tenantId: string): Promise<WeComAppCredentials | undefined> {
    const row = (
      await this.pool.query<{ corp_id: string; agent_id: string; secret: string }>(
        'SELECT corp_id, agent_id, secret FROM wecom_credentials WHERE tenant_id = $1',
        [tenantId],
      )
    ).rows[0];
    if (!row) return undefined;

    let secret = row.secret;
    if (!isCiphertext(secret)) {
      try {
        await this.pool.query(
          'UPDATE wecom_credentials SET secret = $1 WHERE tenant_id = $2',
          [encryptValue(tenantId, secret, this.masterKey), tenantId],
        );
      } catch (err) {
        console.error(`legacy wecom secret re-encryption failed for tenant ${tenantId}: ${String(err)}`);
      }
    } else {
      secret = decryptValue(tenantId, secret, this.masterKey);
    }
    return { corpId: row.corp_id, agentId: row.agent_id, secret };
  }
}
