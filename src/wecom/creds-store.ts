/** A tenant's WeCom self-built app credentials (ADR-0017: credential connections). */
export interface WeComAppCredentials {
  corpId: string;
  secret: string;
  /**
   * The self-built app's agentid — the connection's identity: WeCom has no
   * user OAuth, messages go out with this app, and `message/send` requires
   * the agentid (#47 will consume it at the connector).
   */
  agentId: string;
}

/**
 * The WeCom connector family id (#47's connector manifest carries it; the
 * credential connection created at creds registration references it,
 * ADR-0017). One string, one place — the admin repo, the composition
 * root's token routing, and tests all agree.
 */
export const WECOM_CONNECTOR_ID = 'wecom_messaging';

/**
 * Read side of the per-tenant WeCom app credentials. The token cell needs
 * the plaintext `secret` to fetch app access tokens; storage is ciphertext
 * (ADR-0004, per-tenant derived key) and the Postgres implementation
 * decrypts on read.
 */
export interface WeComCredsStore {
  get(tenantId: string): Promise<WeComAppCredentials | undefined>;
}
