import type { ActionExecutor, ActionResult, ConnectionRecord } from '../executor.js';
import type { AllowlistStore } from '../governance.js';

/**
 * One MCP tool definition: the protocol view of an action (CONTEXT.md:
 * "MCP Tool — the MCP-protocol view of an action... the mapping is a thin
 * adapter and never changes action semantics"). The input schema is the
 * action's registry schema verbatim — the registry is the single source of
 * truth (ADR-0001), and agent-facing descriptions double as tool docs.
 */
export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * The protocol-agnostic MCP adapter (T5): the thin view of the action layer
 * that the MCP transport hangs off. It owns the two per-(tenant, connection)
 * questions the MCP surface must answer:
 *
 * - **what tools can this caller see** — registry ∩ allowlist ∩ connector
 *   `implements` (ADR-0002 hide-don't-reject; a connection cannot use tools
 *   its connector doesn't implement, mirroring the executor's capability
 *   check);
 * - **how does a call execute** — by routing through `executeAction`, so
 *   allowlist enforcement and audit logging (T4) apply unchanged.
 *
 * All action logic lives in the executor; this adapter adds none.
 */
export class McpAdapter {
  constructor(
    private readonly executor: ActionExecutor,
    private readonly allowlists: AllowlistStore,
  ) {}

  /**
   * Resolves a connection for the authenticated tenant. Undefined when the
   * connection does not exist or belongs to another tenant (the lookup is
   * tenant-isolated by key).
   */
  async resolveConnection(
    tenantId: string,
    connectionId: string,
  ): Promise<ConnectionRecord | undefined> {
    return this.executor.getConnection(tenantId, connectionId);
  }

  /**
   * The tool list for a (tenant, connection): registry actions the
   * connection's allowlist permits and its connector implements. Empty for
   * unknown connections.
   */
  async listTools(tenantId: string, connectionId: string): Promise<McpToolDefinition[]> {
    const connection = await this.executor.getConnection(tenantId, connectionId);
    if (!connection) return [];
    const connector = this.executor.getConnector(connection.connectorId);
    if (!connector) return [];
    const allowed = new Set(await this.allowlists.getAllowedActions(tenantId, connectionId));
    return this.executor
      .listActions()
      .filter(
        (action) => allowed.has(action.name) && connector.manifest.implements.includes(action.name),
      )
      .map((action) => ({
        name: action.name,
        description: action.description,
        inputSchema: action.inputSchema,
      }));
  }

  /** The tool definition for one action, or undefined when it is not visible. */
  async getTool(
    tenantId: string,
    connectionId: string,
    actionName: string,
  ): Promise<McpToolDefinition | undefined> {
    const tools = await this.listTools(tenantId, connectionId);
    return tools.find((tool) => tool.name === actionName);
  }

  /**
   * Executes an action through the executor (Seam A): allowlist gate,
   * schema validation, audit row, unified error vocabulary (ADR-0005) all
   * apply. The caller is responsible for having resolved the tool first.
   */
  callTool(tenantId: string, connectionId: string, actionName: string, args: unknown): Promise<ActionResult> {
    return this.executor.executeAction(tenantId, connectionId, actionName, args);
  }
}
