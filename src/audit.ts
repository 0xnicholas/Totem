import { createHash } from 'node:crypto';

/** Canonical JSON: keys sorted depth-first, so equal values hash equally. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a.localeCompare(b),
    );
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** SHA-256 hex of canonicalized params, for audit_logs.param_hash. */
export function auditParamHash(params: unknown): string {
  return createHash('sha256').update(canonicalJson(params)).digest('hex');
}
