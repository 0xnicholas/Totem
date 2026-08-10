import type { ActionErrorCode } from './errors.js';

/**
 * Per-connection action allowlists (CONTEXT.md): the list of unified action
 * names that may execute on a connection. An empty list is fail-closed —
 * nothing may execute. The MCP layer (T5) also reads this to hide tools
 * (ADR-0002).
 */
export interface AllowlistStore {
  getAllowedActions(tenantId: string, connectionId: string): Promise<string[]>;
}

/** One structured audit row for an action execution attempt. */
export interface ExecutionAudit {
  tenantId: string;
  connectionId: string | null;
  /** Acting user where available; v1 action calls carry none (owner lands with T6). */
  userId: string | null;
  actionName: string;
  /** SHA-256 hex of canonicalized params. */
  paramHash: string;
  /** v1's only action-execution transport; revisit if others call executeAction. */
  source: 'mcp';
  success: boolean;
  /** ADR-0005 error code when the attempt failed. */
  errorCode: ActionErrorCode | null;
  durationMs: number;
  createdAt: string;
}

/**
 * Append-only audit sink for execution attempts. Writes are best effort:
 * the executor logs and continues when a write fails, so an audit outage
 * never takes down the action layer.
 */
export interface AuditSink {
  writeAudit(row: ExecutionAudit): Promise<void>;
}

/**
 * A tenant's audit policy (T11): the schema fields (tenants.audit_error_only
 * etc.) as the executor sees them. `errorOnly` tenants skip success rows —
 * the audit trail then answers "what failed, when" at a fraction of the
 * volume. Failures are always recorded.
 */
export interface AuditPolicy {
  errorOnly: boolean;
}

/**
 * The executor's audit-policy seam (T11): how `executeAction` learns
 * whether a tenant wants error-only logging. Optional — without a provider
 * every attempt is recorded (the v1 default).
 */
export interface AuditPolicyProvider {
  getPolicy(tenantId: string): Promise<AuditPolicy>;
}
