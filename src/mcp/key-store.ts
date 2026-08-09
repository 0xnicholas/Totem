/**
 * Key verification for the MCP surface (T5): tenant API keys
 * (`tt_live_...` / `tt_dev_...`) presented as Bearer tokens. The store
 * resolves a SHA-256 key hash to the owning tenant — only enabled
 * actions-scoped keys authenticate; admin-scoped keys and disabled keys
 * resolve to nothing (401), matching the T3 key-scope amendment.
 */
export interface MCPKeyStore {
  /**
   * Resolves an enabled actions-scoped key by its hash. The
   * implementation may also record key use (the Postgres store updates
   * `last_used_at`).
   */
  findKey(keyHash: string): Promise<{ tenantId: string; keyId: string } | undefined>;
}
