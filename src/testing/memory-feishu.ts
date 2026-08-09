/* eslint-disable @typescript-eslint/require-await -- test doubles: implement async interfaces synchronously */
import type { FeishuAppCredentials, FeishuCredsStore } from '../feishu/creds-store.js';
import type { StoredTokens, TokenStore } from '../feishu/token-store.js';
import type { ConnectionStateStore } from '../feishu/token-manager.js';

/** In-memory `FeishuCredsStore` double; secrets are stored as given (plaintext in tests). */
export class InMemoryFeishuCredsStore implements FeishuCredsStore {
  private readonly creds = new Map<string, FeishuAppCredentials>();

  set(tenantId: string, creds: FeishuAppCredentials): void {
    this.creds.set(tenantId, { ...creds });
  }

  clear(): void {
    this.creds.clear();
  }

  async get(tenantId: string): Promise<FeishuAppCredentials | undefined> {
    return this.creds.get(tenantId);
  }
}

/** In-memory `TokenStore` double, one row per connection. */
export class InMemoryTokenStore implements TokenStore {
  private readonly tokens = new Map<string, StoredTokens>();

  async get(connectionId: string): Promise<StoredTokens | undefined> {
    return this.tokens.get(connectionId);
  }

  async upsert(tokens: StoredTokens): Promise<void> {
    this.tokens.set(tokens.connectionId, { ...tokens });
  }

  list(): StoredTokens[] {
    return [...this.tokens.values()];
  }
}

/** In-memory `ConnectionStateStore` double tracking statuses per connection. */
export class InMemoryConnectionStateStore implements ConnectionStateStore {
  private readonly statuses = new Map<string, string>();

  async getStatus(connectionId: string): Promise<string | undefined> {
    return this.statuses.get(connectionId);
  }

  async markAuthExpired(connectionId: string): Promise<void> {
    this.statuses.set(connectionId, 'auth_expired');
  }

  getStatusSync(connectionId: string): string | undefined {
    return this.statuses.get(connectionId);
  }
}
