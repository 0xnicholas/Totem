/* eslint-disable @typescript-eslint/require-await -- test doubles: implement async interfaces synchronously */
import type { AllowlistStore, AuditSink, ExecutionAudit } from '../governance.js';

function allowlistKey(tenantId: string, connectionId: string): string {
  return `${tenantId}\u0000${connectionId}`;
}

/** In-memory `AllowlistStore` test double for Seam A tests. */
export class InMemoryAllowlistStore implements AllowlistStore {
  private readonly allowed = new Map<string, Set<string>>();

  setAllowed(tenantId: string, connectionId: string, actions: string[]): void {
    this.allowed.set(allowlistKey(tenantId, connectionId), new Set(actions));
  }

  async getAllowedActions(tenantId: string, connectionId: string): Promise<string[]> {
    return [...(this.allowed.get(allowlistKey(tenantId, connectionId)) ?? [])];
  }
}

/** In-memory `AuditSink` test double for Seam A tests. */
export class InMemoryAuditSink implements AuditSink {
  private readonly rows: ExecutionAudit[] = [];

  async writeAudit(row: ExecutionAudit): Promise<void> {
    this.rows.push({ ...row });
  }

  /** All written rows, oldest first. */
  list(): ExecutionAudit[] {
    return [...this.rows];
  }
}
