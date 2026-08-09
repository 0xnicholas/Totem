import { describe, expect, it } from 'vitest';
import {
  decryptValue,
  deriveTenantKey,
  encryptValue,
  isCiphertext,
} from '../src/feishu/crypto.js';

const MASTER_KEY = 'test-master-key-0123456789abcdef';

describe('Feishu secret crypto (ADR-0004 per-tenant keys)', () => {
  it('round-trips a value for its own tenant', () => {
    const stored = encryptValue('tenant-a', 's3cret-value', MASTER_KEY);
    expect(stored.startsWith('v1:')).toBe(true);
    expect(decryptValue('tenant-a', stored, MASTER_KEY)).toBe('s3cret-value');
    // The ciphertext never contains the plaintext.
    expect(stored).not.toContain('s3cret-value');
  });

  it('derives a different key per tenant', () => {
    const a = deriveTenantKey(MASTER_KEY, 'tenant-a');
    const b = deriveTenantKey(MASTER_KEY, 'tenant-b');
    expect(a.equals(b)).toBe(false);
    expect(a.length).toBe(32);
    expect(deriveTenantKey(MASTER_KEY, 'tenant-a').equals(a)).toBe(true);
  });

  it('does not decrypt under another tenant (per-tenant key isolation)', () => {
    const stored = encryptValue('tenant-a', 'secret-a', MASTER_KEY);
    expect(() => decryptValue('tenant-b', stored, MASTER_KEY)).toThrow();
    expect(() => decryptValue('tenant-a', stored, 'another-master-key')).toThrow();
  });

  it('detects tampered ciphertext (GCM authentication)', () => {
    const stored = encryptValue('tenant-a', 'integrity-check', MASTER_KEY);
    const [, iv, ciphertext] = stored.split(':') as [string, string, string];
    // Flip one character of the ciphertext body.
    const flipped =
      ciphertext.slice(0, 4) + (ciphertext[4] === 'A' ? 'B' : 'A') + ciphertext.slice(5);
    expect(() => decryptValue('tenant-a', `v1:${iv}:${flipped}`, MASTER_KEY)).toThrow();
  });

  it('rejects malformed stored values', () => {
    expect(() => decryptValue('tenant-a', 'not-ciphertext', MASTER_KEY)).toThrow();
    expect(() => decryptValue('tenant-a', 'v1:short', MASTER_KEY)).toThrow();
  });

  it('isCiphertext distinguishes the v1 format from legacy plaintext', () => {
    expect(isCiphertext('v1:abc:def')).toBe(true);
    expect(isCiphertext('plaintext-secret')).toBe(false);
    expect(isCiphertext('')).toBe(false);
  });
});
