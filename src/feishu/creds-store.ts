/** A tenant's Feishu app credentials (own-app model per StackOne research). */
export interface FeishuAppCredentials {
  appId: string;
  appSecret: string;
}

/**
 * Read side of the per-tenant Feishu app credentials. The OAuth flow and
 * the TokenManager's refresh path both need the plaintext `appSecret`;
 * storage is ciphertext (ADR-0004, issue #15) and the Postgres
 * implementation decrypts on read.
 */
export interface FeishuCredsStore {
  get(tenantId: string): Promise<FeishuAppCredentials | undefined>;
}
