/* eslint-disable @typescript-eslint/require-await -- test double: implements an async interface synchronously */
import type { WeComAppCredentials, WeComCredsStore } from '../wecom/creds-store.js';

/** In-memory `WeComCredsStore` double; secrets are stored as given (plaintext in tests). */
export class InMemoryWeComCredsStore implements WeComCredsStore {
  private readonly creds = new Map<string, WeComAppCredentials>();

  set(tenantId: string, creds: WeComAppCredentials): void {
    this.creds.set(tenantId, { ...creds });
  }

  clear(): void {
    this.creds.clear();
  }

  async get(tenantId: string): Promise<WeComAppCredentials | undefined> {
    return this.creds.get(tenantId);
  }
}
