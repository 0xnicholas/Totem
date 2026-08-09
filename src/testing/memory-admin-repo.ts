/* eslint-disable @typescript-eslint/require-await -- test double: implements an async interface synchronously */
import {
  ADMIN_AUDIT_ACTIONS,
  NotFoundError,
  type AdminRepository,
  type ApiKeyRecord,
  type ApiKeyScope,
  type AuditFilters,
  type AuditRow,
  type FeishuCreds,
  type Tenant,
} from '../admin/repo.js';
import { auditParamHash } from '../audit.js';

interface MemoryConnection {
  id: string;
  tenantId: string;
  status: 'active' | 'suspended' | 'auth_expired';
}

/**
 * In-memory `AdminRepository` test double, mirroring the Postgres
 * implementation's semantics (audit rows on every mutation, replace
 * semantics for allowlists, NotFoundError). Used at the HTTP boundary in
 * admin API tests; the SQL surface itself is covered by
 * `PostgresAdminRepository` integration tests.
 */
export class InMemoryAdminRepository implements AdminRepository {
  private readonly tenants = new Map<string, Tenant>();
  private readonly apiKeys = new Map<string, ApiKeyRecord>();
  private readonly creds = new Map<string, FeishuCreds>();
  private readonly allowlists = new Map<string, Set<string>>();
  private readonly connections = new Map<string, MemoryConnection>();
  private readonly audit: AuditRow[] = [];

  /** Seeds a connection (connections are created by the OAuth flow, T6). */
  addConnection(tenantId: string, connectionId: string, status: MemoryConnection['status'] = 'active'): void {
    this.connections.set(connectionId, { id: connectionId, tenantId, status });
  }

  listAllowlist(connectionId: string): string[] {
    return [...(this.allowlists.get(connectionId) ?? [])];
  }

  getConnectionStatus(connectionId: string): string | undefined {
    return this.connections.get(connectionId)?.status;
  }

  listAudit(): AuditRow[] {
    return [...this.audit];
  }

  async createTenant(name: string): Promise<Tenant> {
    const tenant: Tenant = { id: crypto.randomUUID(), name, createdAt: new Date().toISOString() };
    this.tenants.set(tenant.id, tenant);
    this.writeAudit({ tenantId: tenant.id, actionName: ADMIN_AUDIT_ACTIONS.tenantCreated, params: { name } });
    return tenant;
  }

  async getTenant(id: string): Promise<Tenant | undefined> {
    return this.tenants.get(id);
  }

  async createApiKey(
    tenantId: string,
    scope: ApiKeyScope,
    key: { prefix: string; keyHash: string },
  ): Promise<ApiKeyRecord> {
    this.requireTenant(tenantId);
    const record: ApiKeyRecord = {
      id: crypto.randomUUID(),
      tenantId,
      prefix: key.prefix,
      keyHash: key.keyHash,
      scope,
      disabledAt: null,
      lastUsedAt: null,
      createdAt: new Date().toISOString(),
    };
    this.apiKeys.set(record.id, record);
    this.writeAudit({
      tenantId,
      actionName: ADMIN_AUDIT_ACTIONS.keyIssued,
      params: { keyId: record.id, scope },
    });
    return record;
  }

  async getApiKey(tenantId: string, keyId: string): Promise<ApiKeyRecord | undefined> {
    const key = this.apiKeys.get(keyId);
    return key?.tenantId === tenantId ? key : undefined;
  }

  async findAdminKey(keyHash: string): Promise<{ tenantId: string; keyId: string } | undefined> {
    for (const key of this.apiKeys.values()) {
      if (key.keyHash === keyHash && key.scope === 'admin' && key.disabledAt === null) {
        return { tenantId: key.tenantId, keyId: key.id };
      }
    }
    return undefined;
  }

  async disableApiKey(tenantId: string, keyId: string): Promise<boolean> {
    const key = this.apiKeys.get(keyId);
    if (!key || key.tenantId !== tenantId) return false;
    if (key.disabledAt !== null) return false;
    key.disabledAt = new Date().toISOString();
    this.writeAudit({
      tenantId,
      actionName: ADMIN_AUDIT_ACTIONS.keyDisabled,
      params: { keyId },
    });
    return true;
  }

  async setFeishuCreds(tenantId: string, creds: FeishuCreds): Promise<void> {
    this.requireTenant(tenantId);
    this.creds.set(tenantId, creds);
    // The secret stays out of the audit trail (param_hash covers appId only).
    this.writeAudit({
      tenantId,
      actionName: ADMIN_AUDIT_ACTIONS.feishuCredsUpdated,
      params: { appId: creds.appId },
    });
  }

  getFeishuCreds(tenantId: string): FeishuCreds | undefined {
    return this.creds.get(tenantId);
  }

  async setAllowlist(connectionId: string, actions: string[]): Promise<void> {
    const connection = this.requireConnection(connectionId);
    this.allowlists.set(connectionId, new Set(actions));
    this.writeAudit({
      tenantId: connection.tenantId,
      connectionId,
      actionName: ADMIN_AUDIT_ACTIONS.allowlistUpdated,
      params: { connectionId, actions },
    });
  }

  async suspendConnection(connectionId: string, suspended: boolean): Promise<void> {
    const connection = this.requireConnection(connectionId);
    connection.status = suspended ? 'suspended' : 'active';
    this.writeAudit({
      tenantId: connection.tenantId,
      connectionId,
      actionName: suspended
        ? ADMIN_AUDIT_ACTIONS.connectionSuspended
        : ADMIN_AUDIT_ACTIONS.connectionResumed,
      params: { connectionId },
    });
  }

  async queryAudit(tenantId: string, filters: AuditFilters): Promise<AuditRow[]> {
    this.requireTenant(tenantId);
    const rows = this.audit.filter(
      (row) =>
        row.tenantId === tenantId &&
        (filters.userId === undefined || row.userId === filters.userId) &&
        (filters.action === undefined || row.actionName === filters.action) &&
        (filters.since === undefined || row.createdAt >= filters.since) &&
        (filters.source === undefined || row.source === filters.source) &&
        (filters.success === undefined || row.success === filters.success),
    );
    // Insertion order is chronological; newest first (matches the SQL's
    // ORDER BY created_at DESC, without sub-millisecond tie hazards).
    return rows.reverse().slice(0, 1000);
  }

  private writeAudit(input: {
    tenantId: string;
    connectionId?: string;
    actionName: string;
    params: unknown;
  }): void {
    const row: AuditRow = {
      id: crypto.randomUUID(),
      tenantId: input.tenantId,
      connectionId: input.connectionId ?? null,
      userId: 'admin',
      actionName: input.actionName,
      paramHash: auditParamHash(input.params),
      source: 'admin_api',
      success: true,
      errorCode: null,
      durationMs: 0,
      createdAt: new Date().toISOString(),
    };
    this.audit.push(row);
  }

  private requireTenant(tenantId: string): void {
    if (!this.tenants.has(tenantId)) throw new NotFoundError(`Tenant "${tenantId}" not found`);
  }

  private requireConnection(connectionId: string): MemoryConnection {
    const connection = this.connections.get(connectionId);
    if (!connection) throw new NotFoundError(`Connection "${connectionId}" not found`);
    return connection;
  }
}
