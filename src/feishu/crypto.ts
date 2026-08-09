import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';

/**
 * Secret encryption at rest (ADR-0004, issue #15): every stored secret —
 * Feishu tokens and app secrets — is AES-256-GCM encrypted with a
 * per-tenant key derived from the `TOTEM_TOKEN_ENC_KEY` master key, so one
 * leaked row does not decrypt with another tenant's key and a leaked master
 * key alone is not enough.
 *
 * Storage format: `v1:<iv (base64url)>:<ciphertext+tag (base64url)>`.
 * GCM authenticates the ciphertext, so tampered rows fail decryption
 * instead of producing garbage secrets.
 */

/** HMAC-SHA256 key derivation: master key + tenant context → 32-byte key. */
export function deriveTenantKey(masterKey: string, tenantId: string): Buffer {
  return createHmac('sha256', masterKey).update(`totem:feishu:v1:${tenantId}`).digest();
}

/** True when the stored value is in the v1 ciphertext format (vs legacy plaintext). */
export function isCiphertext(stored: string): boolean {
  return stored.startsWith('v1:');
}

export function encryptValue(tenantId: string, plaintext: string, masterKey: string): string {
  const key = deriveTenantKey(masterKey, tenantId);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    'v1',
    iv.toString('base64url'),
    Buffer.concat([encrypted, tag]).toString('base64url'),
  ].join(':');
}

/** @throws when the value is malformed, tampered, or from another tenant/key. */
export function decryptValue(tenantId: string, stored: string, masterKey: string): string {
  const parts = stored.split(':');
  if (parts.length !== 3 || parts[0] !== 'v1') {
    throw new Error('Malformed encrypted value (expected v1:<iv>:<ciphertext>)');
  }
  const key = deriveTenantKey(masterKey, tenantId);
  const iv = Buffer.from(parts[1]!, 'base64url');
  const body = Buffer.from(parts[2]!, 'base64url');
  if (iv.length !== 12 || body.length < 17) {
    throw new Error('Malformed encrypted value (bad iv or ciphertext length)');
  }
  const tag = body.subarray(body.length - 16);
  const ciphertext = body.subarray(0, body.length - 16);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
