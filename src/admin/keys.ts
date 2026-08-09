import { createHash, randomBytes } from 'node:crypto';
import type { ApiKeyScope } from './repo.js';

export const KEY_PREFIXES = { live: 'tt_live_', dev: 'tt_dev_' } as const;

/** `tt_live_` in production, `tt_dev_` elsewhere (StackOne amendment). */
export function keyPrefixForEnv(production: boolean): string {
  return production ? KEY_PREFIXES.live : KEY_PREFIXES.dev;
}

/** SHA-256 hex of the full key; the only thing stored at rest. */
export function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

export interface GeneratedApiKey {
  plaintext: string;
  prefix: string;
  keyHash: string;
  scope: ApiKeyScope;
}

/** Generates `<prefix><32 random bytes base64url>`. The plaintext is shown once. */
export function generateApiKey(prefix: string, scope: ApiKeyScope): GeneratedApiKey {
  const plaintext = `${prefix}${randomBytes(32).toString('base64url')}`;
  return { plaintext, prefix, keyHash: hashApiKey(plaintext), scope };
}
