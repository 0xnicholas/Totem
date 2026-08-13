/**
 * The encrypted-at-rest token row for one connection (ADR-0004): both
 * tokens are ciphertext (`v1:` format, per-tenant key). The store never
 * sees plaintext. Provider-agnostic: rows are keyed by connection, and
 * the token shape is the platform's, not any provider's.
 */
export interface StoredTokens {
  tenantId: string;
  connectionId: string;
  accessTokenCiphertext: string;
  refreshTokenCiphertext: string;
  /** ISO expiry of the access token (kept in plaintext for refresh decisions). */
  expiresAt: string;
}

/**
 * Persistence seam of the token lifecycle (ADR-0004): token storage is
 * injectable so tests use an in-memory fake. One row per connection;
 * `upsert` replaces the row atomically (the single-flight discipline in
 * the token lifecycle makes concurrent refreshes per connection
 * impossible, so no optimistic-control dance is needed in v1's single
 * process).
 */
export interface TokenStore {
  get(connectionId: string): Promise<StoredTokens | undefined>;
  upsert(tokens: StoredTokens): Promise<void>;
}
