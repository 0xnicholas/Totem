import pg from 'pg';
import type { AllowlistStore, AuditSink, ExecutionAudit } from './governance.js';

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
