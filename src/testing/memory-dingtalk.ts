/* eslint-disable @typescript-eslint/require-await -- test double: implements an async interface synchronously */
import type { DingTalkAppCredentials, DingTalkCredsStore } from '../dingtalk/creds-store.js';

/** In-memory `DingTalkCredsStore` double; secrets are stored as given (plaintext in tests). */
export class InMemoryDingTalkCredsStore implements DingTalkCredsStore {
  private readonly creds = new Map<string, DingTalkAppCredentials>();

  set(tenantId: string, creds: DingTalkAppCredentials): void {
    this.creds.set(tenantId, { ...creds });
  }

  clear(): void {
    this.creds.clear();
  }

  async get(tenantId: string): Promise<DingTalkAppCredentials | undefined> {
    return this.creds.get(tenantId);
  }
}
