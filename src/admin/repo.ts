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

import type { AuditSource } from '../governance.js';

export type { AuditSource };

export type ConnectionStatus = 'active' | 'suspended' | 'auth_expired';

/** Operator-facing view of a connection (T6: OAuth flow + auth state). */
export interface ConnectionView {
  id: string;
  tenantId: string;
  connectorId: string;
  name: string;
  status: ConnectionStatus;
  /** Server-set; v1 always equals the tenant id (research amendment). */
  ownerId: string;
  /** The deployment's canonical OAuth redirect URI, recorded for re-auth. */
  oauthRedirectUri: string | null;
  createdAt: string;
}

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
  /** Free-form enrichment (T15: Defender scan metadata). */
  metadata?: unknown;
}

export interface AuditFilters {
  userId?: string;
  action?: string;
  /** ISO timestamp; filters rows created at or after it. */
  since?: string;
  source?: AuditSource;
  success?: boolean;
  /** Only rows stamped destructive (ADR-0018 `metadata.effects`). */
  destructive?: boolean;
}

export interface FeishuCreds {
  appId: string;
  appSecret: string;
}

/** A tenant's DingTalk app credentials as stored by the admin surface (T17a). */
export interface DingTalkCreds {
  appKey: string;
  appSecret: string;
  /**
   * The app robot's robotCode, ciphertext at rest (#49). Optional with
   * merge semantics: absent leaves the stored value untouched, present
   * replaces it (a separate console value from appKey/appSecret).
   */
  robotCode?: string;
}

/**
 * A tenant's audit policy (T11): the tenants-row config the schema has
 * carried since T2 but nothing read or set. `captureBody` is the opt-in
 * request/response capture flag; body storage itself is v2.
 */
export interface TenantAuditPolicy {
  /** Audit rows older than this many days are purged (enforcement: T11). */
  retentionDays: number;
  /** Error-only mode: successful executions write no audit row. */
  errorOnly: boolean;
  /** Opt-in body capture (flag only; storage v2). */
  captureBody: boolean;
}

/** Partial update for a tenant's audit policy; omitted fields are kept. */
export interface TenantAuditPolicyPatch {
  retentionDays?: number;
  errorOnly?: boolean;
  captureBody?: boolean;
}

/**
 * A tenant's Defender policy (T15, ADR-0009): observe-first defaults —
 * scanning on, blocking off.
 */
export interface TenantDefenderPolicy {
  /** Scan tool responses for injection signatures. */
  enabled: boolean;
  /** Turn high-risk responses into a `forbidden` error instead of returning them. */
  blockHighRisk: boolean;
}

/** Partial update for a tenant's Defender policy; omitted fields are kept. */
export interface TenantDefenderPolicyPatch {
  enabled?: boolean;
  blockHighRisk?: boolean;
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
   * Sets the tenant's DingTalk app credentials (T17a), encrypted at rest
   * by the route's cipher. @throws NotFoundError when the tenant does not
   * exist.
   */
  setDingTalkCreds(tenantId: string, creds: DingTalkCreds): Promise<void>;
  /**
   * Creates a connection for the OAuth flow (T6). `ownerId` is server-set
   * to the tenant id. @throws NotFoundError when the tenant does not exist.
   */
  createConnection(
    tenantId: string,
    input: { connectorId: string; name: string; oauthRedirectUri?: string | null },
  ): Promise<ConnectionView>;
  /** Lists the tenant's connections with their auth state. @throws NotFoundError when the tenant does not exist. */
  listConnections(tenantId: string): Promise<ConnectionView[]>;
  /**
   * Replaces the connection's allowlist. The ADR-0018 acknowledge flag
   * rides the mutation's audit params when set — the opting-in act is
   * itself audited. @throws NotFoundError when the connection does not
   * exist.
   */
  setAllowlist(
    connectionId: string,
    actions: string[],
    acknowledge?: { allowDestructive?: boolean },
  ): Promise<void>;
  /** Sets a connection's status to suspended (true) or active (false). */
  suspendConnection(connectionId: string, suspended: boolean): Promise<void>;
  /** Re-activates a connection (OAuth re-auth path, T6). */
  activateConnection(connectionId: string): Promise<void>;
  /** @throws NotFoundError when the tenant does not exist. */
  queryAudit(tenantId: string, filters: AuditFilters): Promise<AuditRow[]>;
  /**
   * Reads the tenant's audit policy. @throws NotFoundError when the tenant
   * does not exist.
   */
  getAuditPolicy(tenantId: string): Promise<TenantAuditPolicy>;
  /**
   * Partially updates the tenant's audit policy (T11). @throws
   * NotFoundError when the tenant does not exist.
   */
  setAuditPolicy(tenantId: string, patch: TenantAuditPolicyPatch): Promise<TenantAuditPolicy>;
  /** Reads the tenant's Defender policy (T15). @throws NotFoundError when the tenant does not exist. */
  getDefenderPolicy(tenantId: string): Promise<TenantDefenderPolicy>;
  /**
   * Patches the tenant's Defender policy (omitted fields kept), auditing the
   * change. @throws NotFoundError when the tenant does not exist.
   */
  setDefenderPolicy(
    tenantId: string,
    patch: TenantDefenderPolicyPatch,
  ): Promise<TenantDefenderPolicy>;
  /**
   * Deletes the tenant's audit rows older than its retention window.
   * @throws NotFoundError when the tenant does not exist.
   */
  purgeAudit(tenantId: string): Promise<{ deleted: number }>;
}

/** Admin audit action names, in the audit_logs.action_name vocabulary. */
export const ADMIN_AUDIT_ACTIONS = {
  tenantCreated: 'admin.tenant_created',
  keyIssued: 'admin.key_issued',
  keyDisabled: 'admin.key_disabled',
  feishuCredsUpdated: 'admin.feishu_creds_updated',
  dingtalkCredsUpdated: 'admin.dingtalk_creds_updated',
  allowlistUpdated: 'admin.allowlist_updated',
  connectionSuspended: 'admin.connection_suspended',
  connectionResumed: 'admin.connection_resumed',
  connectionCreated: 'admin.connection_created',
  auditPolicyUpdated: 'admin.audit_policy_updated',
  auditPurged: 'admin.audit_purged',
  defenderPolicyUpdated: 'admin.defender_policy_updated',
} as const;
