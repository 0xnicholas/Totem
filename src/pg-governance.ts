import pg from 'pg';
import type {
  AllowlistStore,
  AuditPolicy,
  AuditPolicyProvider,
  AuditSink,
  ExecutionAudit,
} from './governance.js';

/** Reads allowlist rows from Postgres (written by the T3 admin API). */
export class PostgresAllowlistStore implements AllowlistStore {
  constructor(private readonly pool: pg.Pool) {}

  async getAllowedActions(tenantId: string, connectionId: string): Promise<string[]> {
    const rows = await this.pool.query<{ action_name: string }>(
      'SELECT action_name FROM allowlists WHERE tenant_id = $1 AND connection_id = $2 ORDER BY action_name',
      [tenantId, connectionId],
    );
    return rows.rows.map((row) => row.action_name);
  }
}

/** Appends execution audit rows to audit_logs. */
export class PostgresAuditSink implements AuditSink {
  constructor(private readonly pool: pg.Pool) {}

  async writeAudit(row: ExecutionAudit): Promise<void> {
    await this.pool.query(
      `INSERT INTO audit_logs (tenant_id, connection_id, user_id, action_name, param_hash,
                               source, success, error_code, duration_ms)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        row.tenantId,
        row.connectionId,
        row.userId,
        row.actionName,
        row.paramHash,
        row.source,
        row.success,
        row.errorCode,
        row.durationMs,
      ],
    );
  }
}

/**
 * Reads a tenant's audit policy from the tenants row (T11). Unknown
 * tenants resolve to the default policy — the audit write for them would
 * fail the FK anyway, so error-only is moot.
 */
export class PostgresAuditPolicyStore implements AuditPolicyProvider {
  constructor(private readonly pool: pg.Pool) {}

  async getPolicy(tenantId: string): Promise<AuditPolicy> {
    const row = await this.pool.query<{ audit_error_only: boolean }>(
      'SELECT audit_error_only FROM tenants WHERE id = $1',
      [tenantId],
    );
    return { errorOnly: row.rows[0]?.audit_error_only ?? false };
  }
}
