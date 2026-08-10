import pg from 'pg';
import type {
  AllowlistStore,
  AuditPolicy,
  AuditPolicyProvider,
  AuditSink,
  DefenderPolicy,
  DefenderPolicyProvider,
  ExecutionAudit,
} from './governance.js';
import { DEFAULT_DEFENDER_POLICY } from './governance.js';

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
                               source, success, error_code, duration_ms, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
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
        row.metadata === undefined ? null : JSON.stringify(row.metadata),
      ],
    );
  }
}

/**
 * Postgres `DefenderPolicyProvider` (T15): the per-tenant policy columns on
 * the tenants row. A missing tenant resolves to the observe-first defaults —
 * the execution boundary must never break scanning on a lookup miss.
 */
export class PostgresDefenderPolicyStore implements DefenderPolicyProvider {
  constructor(private readonly pool: pg.Pool) {}

  async getPolicy(tenantId: string): Promise<DefenderPolicy> {
    const row = await this.pool.query<{
      defender_enabled: boolean;
      defender_block_high_risk: boolean;
    }>('SELECT defender_enabled, defender_block_high_risk FROM tenants WHERE id = $1', [
      tenantId,
    ]);
    const found = row.rows[0];
    return found
      ? { enabled: found.defender_enabled, blockHighRisk: found.defender_block_high_risk }
      : { ...DEFAULT_DEFENDER_POLICY };
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
