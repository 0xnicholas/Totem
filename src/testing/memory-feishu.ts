/* eslint-disable @typescript-eslint/require-await -- test double: implements an async interface synchronously */
import type { FeishuAppCredentials, FeishuCredsStore } from '../feishu/creds-store.js';

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
