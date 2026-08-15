/** A tenant's DingTalk app credentials (own-app model per StackOne research). */
export interface DingTalkAppCredentials {
  appKey: string;
  appSecret: string;
  /**
   * The app robot's robotCode (console value) — required by the robot
   * messaging APIs (`groupMessages/send`, #49). Optional: tenants that
   * never sync it simply cannot use send_message (the connector fails
   * loudly with an actionable error, never silently).
   */
  robotCode?: string;
}

/**
 * Read side of the per-tenant DingTalk app credentials. The OAuth flow and
 * the TokenManager's refresh path both need the plaintext `appSecret`;
 * storage is ciphertext (ADR-0004, per-tenant derived key) and the
 * Postgres implementation decrypts on read.
 */
export interface DingTalkCredsStore {
  get(tenantId: string): Promise<DingTalkAppCredentials | undefined>;
}
