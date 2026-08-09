/* eslint-disable @typescript-eslint/require-await -- test double: implements an async interface synchronously */
import { hashApiKey } from '../admin/keys.js';
import type { MCPKeyStore } from '../mcp/key-store.js';

interface MemoryKey {
  tenantId: string;
  keyId: string;
  hash: string;
  scope: 'actions' | 'admin';
  disabled: boolean;
  lastUsedAt: string | null;
}

/**
 * In-memory `MCPKeyStore` test double, mirroring the Postgres
 * implementation's semantics: only enabled actions-scoped keys resolve,
 * and a successful lookup records last use.
 */
export class InMemoryMCPKeyStore implements MCPKeyStore {
  private readonly keys = new Map<string, MemoryKey>();

  addKey(
    plaintext: string,
    tenantId: string,
    options: { scope?: 'actions' | 'admin'; disabled?: boolean } = {},
  ): void {
    this.keys.set(plaintext, {
      tenantId,
      keyId: `key_${plaintext}`,
      hash: hashApiKey(plaintext),
      scope: options.scope ?? 'actions',
      disabled: options.disabled ?? false,
      lastUsedAt: null,
    });
  }

  async findKey(keyHash: string): Promise<{ tenantId: string; keyId: string } | undefined> {
    const key = [...this.keys.values()].find((candidate) => candidate.hash === keyHash);
    if (!key || key.disabled || key.scope !== 'actions') return undefined;
    key.lastUsedAt = new Date().toISOString();
    return { tenantId: key.tenantId, keyId: key.keyId };
  }
}
