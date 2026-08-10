import pg from 'pg';
import {
  ADMIN_AUDIT_ACTIONS,
  NotFoundError,
  type AdminRepository,
  type ApiKeyRecord,
  type ApiKeyScope,
  type AuditFilters,
  type AuditRow,
  type AuditSource,
  type ConnectionStatus,
  type ConnectionView,
  type FeishuCreds,
  type Tenant,
  type TenantAuditPolicy,
  type TenantAuditPolicyPatch,
} from './repo.js';
import { auditParamHash } from '../audit.js';

interface AuditInsert {
  tenantId: string;
  connectionId?: string | null;
  actionName: string;
  params: unknown;
  durationMs: number;
}

interface TenantRow {
  id: string;
  name: string;
  created_at: Date;
}

interface TenantPolicyRow {
  audit_retention_days: number;
  audit_error_only: boolean;
  capture_body: boolean;
}

interface ApiKeyRow {
  id: string;
  tenant_id: string;
  prefix: string;
  key_hash: string;
  scope: ApiKeyScope;
  disabled_at: Date | null;
  last_used_at: Date | null;
  created_at: Date;
}

interface ConnectionRow {
  id: string;
  tenant_id: string;
  connector_id: string;
  name: string;
  status: ConnectionStatus;
  owner_id: string;
  oauth_redirect_uri: string | null;
  created_at: Date;
}

interface AuditLogRow {
  id: string;
  tenant_id: string;
  connection_id: string | null;
  user_id: string | null;
  action_name: string;
  param_hash: string;
  source: AuditSource;
  success: boolean;
  error_code: string | null;
  duration_ms: number;
  created_at: Date;
}

/**
 * Postgres implementation of the admin repository. Every mutation and its
 * audit row commit in one transaction, so admin actions are never
 * unaccounted for.
 */
export class PostgresAdminRepository implements AdminRepository {
  constructor(private readonly pool: pg.Pool) {}

  async createTenant(name: string): Promise<Tenant> {
    return this.mutate(async (client) => {
      const row = (
        await client.query<TenantRow>(
          'INSERT INTO tenants (name) VALUES ($1) RETURNING id, name, created_at',
          [name],
        )
      ).rows[0]!;
      await this.writeAudit(client, {
        tenantId: row.id,
        actionName: ADMIN_AUDIT_ACTIONS.tenantCreated,
        params: { name },
        durationMs: 0,
      });
      return mapTenant(row);
    });
  }

  async getTenant(id: string): Promise<Tenant | undefined> {
    const row = (
      await this.pool.query<TenantRow>('SELECT id, name, created_at FROM tenants WHERE id = $1', [id])
    ).rows[0];
    return row ? mapTenant(row) : undefined;
  }

  async createApiKey(
    tenantId: string,
    scope: ApiKeyScope,
    key: { prefix: string; keyHash: string },
  ): Promise<ApiKeyRecord> {
    return this.mutate(async (client) => {
      await this.requireTenant(client, tenantId);
      const row = (
        await client.query<ApiKeyRow>(
          `INSERT INTO api_keys (tenant_id, prefix, key_hash, scope)
           VALUES ($1, $2, $3, $4)
           RETURNING id, tenant_id, prefix, key_hash, scope, disabled_at, last_used_at, created_at`,
          [tenantId, key.prefix, key.keyHash, scope],
        )
      ).rows[0]!;
      await this.writeAudit(client, {
        tenantId,
        actionName: ADMIN_AUDIT_ACTIONS.keyIssued,
        params: { keyId: row.id, scope },
        durationMs: 0,
      });
      return mapApiKey(row);
    });
  }

  async getApiKey(tenantId: string, keyId: string): Promise<ApiKeyRecord | undefined> {
    const row = (
      await this.pool.query<ApiKeyRow>(
        `SELECT id, tenant_id, prefix, key_hash, scope, disabled_at, last_used_at, created_at
         FROM api_keys WHERE id = $1 AND tenant_id = $2`,
        [keyId, tenantId],
      )
    ).rows[0];
    return row ? mapApiKey(row) : undefined;
  }

  async findAdminKey(keyHash: string): Promise<{ tenantId: string; keyId: string } | undefined> {
    const row = (
      await this.pool.query<{ id: string; tenant_id: string }>(
        `SELECT id, tenant_id FROM api_keys
         WHERE key_hash = $1 AND scope = 'admin' AND disabled_at IS NULL`,
        [keyHash],
      )
    ).rows[0];
    return row ? { tenantId: row.tenant_id, keyId: row.id } : undefined;
  }

  async disableApiKey(tenantId: string, keyId: string): Promise<boolean> {
    return this.mutate(async (client) => {
      const result = await client.query<{ id: string }>(
        'UPDATE api_keys SET disabled_at = now() WHERE id = $1 AND tenant_id = $2 AND disabled_at IS NULL',
        [keyId, tenantId],
      );
      if (result.rowCount === 0) return false;
      await this.writeAudit(client, {
        tenantId,
        actionName: ADMIN_AUDIT_ACTIONS.keyDisabled,
        params: { keyId },
        durationMs: 0,
      });
      return true;
    });
  }

  async setFeishuCreds(tenantId: string, creds: FeishuCreds): Promise<void> {
    await this.mutate(async (client) => {
      await this.requireTenant(client, tenantId);
      await client.query(
        `INSERT INTO feishu_credentials (tenant_id, app_id, app_secret)
         VALUES ($1, $2, $3)
         ON CONFLICT (tenant_id) DO UPDATE
           SET app_id = $2, app_secret = $3, updated_at = now()`,
        [tenantId, creds.appId, creds.appSecret],
      );
      // The secret stays out of the audit trail (param_hash covers appId only).
      await this.writeAudit(client, {
        tenantId,
        actionName: ADMIN_AUDIT_ACTIONS.feishuCredsUpdated,
        params: { appId: creds.appId },
        durationMs: 0,
      });
    });
  }

  async createConnection(
    tenantId: string,
    input: { connectorId: string; name: string; oauthRedirectUri?: string | null },
  ): Promise<ConnectionView> {
    return this.mutate(async (client) => {
      await this.requireTenant(client, tenantId);
      const row = (
        await client.query<ConnectionRow>(
          `INSERT INTO connections (tenant_id, connector_id, name, owner_id, oauth_redirect_uri)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id, tenant_id, connector_id, name, status, owner_id, oauth_redirect_uri, created_at`,
          [tenantId, input.connectorId, input.name, tenantId, input.oauthRedirectUri ?? null],
        )
      ).rows[0]!;
      await this.writeAudit(client, {
        tenantId,
        connectionId: row.id,
        actionName: ADMIN_AUDIT_ACTIONS.connectionCreated,
        params: { connectionId: row.id, connectorId: row.connector_id, name: row.name },
        durationMs: 0,
      });
      return mapConnection(row);
    });
  }

  async listConnections(tenantId: string): Promise<ConnectionView[]> {
    const tenant = await this.pool.query<{ one: number }>('SELECT 1 FROM tenants WHERE id = $1', [
      tenantId,
    ]);
    if (tenant.rowCount === 0) throw new NotFoundError(`Tenant "${tenantId}" not found`);
    const rows = (
      await this.pool.query<ConnectionRow>(
        `SELECT id, tenant_id, connector_id, name, status, owner_id, oauth_redirect_uri, created_at
         FROM connections WHERE tenant_id = $1 ORDER BY created_at`,
        [tenantId],
      )
    ).rows;
    return rows.map(mapConnection);
  }

  async setAllowlist(connectionId: string, actions: string[]): Promise<void> {
    await this.mutate(async (client) => {
      const connection = await this.requireConnection(client, connectionId);
      await client.query('DELETE FROM allowlists WHERE connection_id = $1', [connectionId]);
      for (const action of actions) {
        await client.query(
          'INSERT INTO allowlists (tenant_id, connection_id, action_name) VALUES ($1, $2, $3)',
          [connection.tenant_id, connectionId, action],
        );
      }
      await this.writeAudit(client, {
        tenantId: connection.tenant_id,
        connectionId,
        actionName: ADMIN_AUDIT_ACTIONS.allowlistUpdated,
        params: { connectionId, actions },
        durationMs: 0,
      });
    });
  }

  async suspendConnection(connectionId: string, suspended: boolean): Promise<void> {
    await this.mutate(async (client) => {
      const connection = await this.requireConnection(client, connectionId);
      await client.query('UPDATE connections SET status = $1 WHERE id = $2', [
        suspended ? 'suspended' : 'active',
        connectionId,
      ]);
      await this.writeAudit(client, {
        tenantId: connection.tenant_id,
        connectionId,
        actionName: suspended
          ? ADMIN_AUDIT_ACTIONS.connectionSuspended
          : ADMIN_AUDIT_ACTIONS.connectionResumed,
        params: { connectionId },
        durationMs: 0,
      });
    });
  }

  async activateConnection(connectionId: string): Promise<void> {
    await this.suspendConnection(connectionId, false);
  }

  async queryAudit(tenantId: string, filters: AuditFilters): Promise<AuditRow[]> {
    const row = await this.pool.query<{ one: number }>('SELECT 1 FROM tenants WHERE id = $1', [tenantId]);
    if (row.rowCount === 0) throw new NotFoundError(`Tenant "${tenantId}" not found`);
    const conditions = ['tenant_id = $1'];
    const params: unknown[] = [tenantId];
    if (filters.userId !== undefined) {
      params.push(filters.userId);
      conditions.push(`user_id = $${params.length}`);
    }
    if (filters.action !== undefined) {
      params.push(filters.action);
      conditions.push(`action_name = $${params.length}`);
    }
    if (filters.since !== undefined) {
      params.push(filters.since);
      conditions.push(`created_at >= $${params.length}`);
    }
    if (filters.source !== undefined) {
      params.push(filters.source);
      conditions.push(`source = $${params.length}`);
    }
    if (filters.success !== undefined) {
      params.push(filters.success);
      conditions.push(`success = $${params.length}`);
    }
    const rows = (
      await this.pool.query<AuditLogRow>(
        `SELECT id, tenant_id, connection_id, user_id, action_name, param_hash, source,
                success, error_code, duration_ms, created_at
         FROM audit_logs WHERE ${conditions.join(' AND ')}
         ORDER BY created_at DESC LIMIT 1000`,
        params,
      )
    ).rows;
    return rows.map(mapAuditRow);
  }

  async getAuditPolicy(tenantId: string): Promise<TenantAuditPolicy> {
    const row = (
      await this.pool.query<TenantPolicyRow>(
        `SELECT audit_retention_days, audit_error_only, capture_body
         FROM tenants WHERE id = $1`,
        [tenantId],
      )
    ).rows[0];
    if (!row) throw new NotFoundError(`Tenant "${tenantId}" not found`);
    return mapAuditPolicy(row);
  }

  async setAuditPolicy(
    tenantId: string,
    patch: TenantAuditPolicyPatch,
  ): Promise<TenantAuditPolicy> {
    return this.mutate(async (client) => {
      await this.requireTenant(client, tenantId);
      const row = (
        await client.query<TenantPolicyRow>(
          `UPDATE tenants SET
             audit_retention_days = COALESCE($2, audit_retention_days),
             audit_error_only     = COALESCE($3, audit_error_only),
             capture_body         = COALESCE($4, capture_body)
           WHERE id = $1
           RETURNING audit_retention_days, audit_error_only, capture_body`,
          [tenantId, patch.retentionDays ?? null, patch.errorOnly ?? null, patch.captureBody ?? null],
        )
      ).rows[0]!;
      await this.writeAudit(client, {
        tenantId,
        actionName: ADMIN_AUDIT_ACTIONS.auditPolicyUpdated,
        params: patch,
        durationMs: 0,
      });
      return mapAuditPolicy(row);
    });
  }

  async purgeAudit(tenantId: string): Promise<{ deleted: number }> {
    return this.mutate(async (client) => {
      await this.requireTenant(client, tenantId);
      const deleted = await client.query(
        `DELETE FROM audit_logs
         WHERE tenant_id = $1
           AND created_at < now() - make_interval(days => (
             SELECT audit_retention_days FROM tenants WHERE id = $1
           ))`,
        [tenantId],
      );
      await this.writeAudit(client, {
        tenantId,
        actionName: ADMIN_AUDIT_ACTIONS.auditPurged,
        params: { deleted: deleted.rowCount ?? 0 },
        durationMs: 0,
      });
      return { deleted: deleted.rowCount ?? 0 };
    });
  }

  private async mutate<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  private async writeAudit(client: pg.PoolClient, audit: AuditInsert): Promise<void> {
    await client.query(
      `INSERT INTO audit_logs (tenant_id, connection_id, user_id, action_name, param_hash,
                               source, success, duration_ms)
       VALUES ($1, $2, 'admin', $3, $4, 'admin_api', true, $5)`,
      [
        audit.tenantId,
        audit.connectionId ?? null,
        audit.actionName,
        auditParamHash(audit.params),
        audit.durationMs,
      ],
    );
  }

  private async requireTenant(client: pg.PoolClient, tenantId: string): Promise<void> {
    const row = await client.query<{ one: number }>('SELECT 1 FROM tenants WHERE id = $1', [tenantId]);
    if (row.rowCount === 0) throw new NotFoundError(`Tenant "${tenantId}" not found`);
  }

  private async requireConnection(
    client: pg.PoolClient,
    connectionId: string,
  ): Promise<{ tenant_id: string }> {
    const row = await client.query<{ tenant_id: string }>(
      'SELECT tenant_id FROM connections WHERE id = $1',
      [connectionId],
    );
    if (row.rowCount === 0) throw new NotFoundError(`Connection "${connectionId}" not found`);
    return row.rows[0] as { tenant_id: string };
  }
}

function mapTenant(row: { id: string; name: string; created_at: Date }): Tenant {
  return { id: row.id, name: row.name, createdAt: row.created_at.toISOString() };
}

function mapAuditPolicy(row: TenantPolicyRow): TenantAuditPolicy {
  return {
    retentionDays: row.audit_retention_days,
    errorOnly: row.audit_error_only,
    captureBody: row.capture_body,
  };
}

function mapConnection(row: ConnectionRow): ConnectionView {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    connectorId: row.connector_id,
    name: row.name,
    status: row.status,
    ownerId: row.owner_id,
    oauthRedirectUri: row.oauth_redirect_uri,
    createdAt: row.created_at.toISOString(),
  };
}

function mapApiKey(row: {
  id: string;
  tenant_id: string;
  prefix: string;
  key_hash: string;
  scope: ApiKeyScope;
  disabled_at: Date | null;
  last_used_at: Date | null;
  created_at: Date;
}): ApiKeyRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    prefix: row.prefix,
    keyHash: row.key_hash,
    scope: row.scope,
    disabledAt: row.disabled_at?.toISOString() ?? null,
    lastUsedAt: row.last_used_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
  };
}

function mapAuditRow(row: {
  id: string;
  tenant_id: string;
  connection_id: string | null;
  user_id: string | null;
  action_name: string;
  param_hash: string;
  source: AuditSource;
  success: boolean;
  error_code: string | null;
  duration_ms: number;
  created_at: Date;
}): AuditRow {
  return {
    id: String(row.id),
    tenantId: row.tenant_id,
    connectionId: row.connection_id,
    userId: row.user_id,
    actionName: row.action_name,
    paramHash: row.param_hash,
    source: row.source,
    success: row.success,
    errorCode: row.error_code,
    durationMs: row.duration_ms,
    createdAt: row.created_at.toISOString(),
  };
}
