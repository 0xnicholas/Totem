/**
 * Marks a connection as needing re-authorization. The Postgres
 * implementation sets `connections.status = 'auth_expired'`, the
 * first-class status the StackOne research amendment introduced.
 * Provider-agnostic: the marking is a platform concern, driven by the
 * token lifecycle when a provider reports a dead grant.
 */
export interface ConnectionStateStore {
  /** The connection's status, used to fail fast after `markAuthExpired`. */
  getStatus(connectionId: string): Promise<string | undefined>;
  markAuthExpired(connectionId: string): Promise<void>;
}
