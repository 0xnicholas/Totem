import { createHash } from 'node:crypto';

export interface Tenant {
  id: string;
  name: string;
  createdAt: string;
}

export type ApiKeyScope = 'actions' | 'admin';

export interface ApiKeyRecord {
  id: string;
  tenantId: string;
  prefix: string;
  keyHash: string;
  scope: ApiKeyScope;
  disabledAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
}

export type AuditSource = 'mcp' | 'admin_api' | 'cli';

export interface AuditRow {
  id: string;
  tenantId: string;
  connectionId: string | null;
  userId: string | null;
  actionName: string;
  paramHash: string;
  source: AuditSource;
  success: boolean;
  errorCode: string | null;
  durationMs: number;
  createdAt: string;
}

export interface AuditFilters {
  userId?: string;
  action?: string;
  /** ISO timestamp; filters rows created at or after it. */
  since?: string;
  source?: AuditSource;
  success?: boolean;
}

export interface FeishuCreds {
  appId: string;
  appSecret: string;
}

/** Raised when a referenced row (tenant, connection, key) does not exist. */
export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}

/**
 * Persistence seam of the admin surface. Every mutation also writes an
 * audit_logs row (source `admin_api`, user `admin`) — atomically with the
 * mutation for the Postgres implementation — so all admin actions are
 * accountable (StackOne amendment). `param_hash` covers the mutation's
 * arguments; secrets are excluded from it.
 */
export interface AdminRepository {
  createTenant(name: string): Promise<Tenant>;
  getTenant(id: string): Promise<Tenant | undefined>;
  createApiKey(
    tenantId: string,
    scope: ApiKeyScope,
    key: { prefix: string; keyHash: string },
  ): Promise<ApiKeyRecord>;
  getApiKey(tenantId: string, keyId: string): Promise<ApiKeyRecord | undefined>;
  /** Disables the key (sets disabled_at). Returns false if already disabled. */
  disableApiKey(tenantId: string, keyId: string): Promise<boolean>;
  /**
   * Looks up an enabled admin-scoped key by hash. Admin-scoped tenant keys
   * are admin API credentials in addition to the bootstrap env key.
   */
  findAdminKey(keyHash: string): Promise<{ tenantId: string; keyId: string } | undefined>;
  /** @throws NotFoundError when the tenant does not exist. */
  setFeishuCreds(tenantId: string, creds: FeishuCreds): Promise<void>;
  /**
   * Replaces the connection's allowlist. @throws NotFoundError when the
   * connection does not exist.
   */
  setAllowlist(connectionId: string, actions: string[]): Promise<void>;
  /** Sets a connection's status to suspended (true) or active (false). */
  suspendConnection(connectionId: string, suspended: boolean): Promise<void>;
  /** @throws NotFoundError when the tenant does not exist. */
  queryAudit(tenantId: string, filters: AuditFilters): Promise<AuditRow[]>;
}

/** Admin audit action names, in the audit_logs.action_name vocabulary. */
export const ADMIN_AUDIT_ACTIONS = {
  tenantCreated: 'admin.tenant_created',
  keyIssued: 'admin.key_issued',
  keyDisabled: 'admin.key_disabled',
  feishuCredsUpdated: 'admin.feishu_creds_updated',
  allowlistUpdated: 'admin.allowlist_updated',
  connectionSuspended: 'admin.connection_suspended',
  connectionResumed: 'admin.connection_resumed',
} as const;

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
