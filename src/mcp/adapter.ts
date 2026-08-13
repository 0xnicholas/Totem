import type { ActionExecutor, ActionResult, ConnectionRecord } from '../executor.js';
import type { ActionEffect, ActionDeprecation, VisibleAction } from '../action.js';

/** MCP tool annotations: the protocol hints about an action's consequences. */
export interface McpToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
  title?: string;
}

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
  /** Effect-derived hints (T10): read → readOnlyHint, destructive → destructiveHint. */
  annotations?: McpToolAnnotations;
}

/**
 * The protocol-agnostic MCP adapter (T5): the thin view of the action layer
 * that the MCP transport hangs off. The tool-list question lives at Seam A
 * (`executor.listAllowedTools` — registry ∩ allowlist ∩ connector
 * `implements`, ADR-0002 hide-don't-reject); this adapter translates only
 * the MCP wire format: tool definitions, effect annotations, the
 * deprecation marker. Calls route through `executeAction`, so allowlist
 * enforcement and audit logging (T4) apply unchanged — the adapter carries
 * no governance data.
 */
export class McpAdapter {
  constructor(private readonly executor: ActionExecutor) {}

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
   * The tool list for a (tenant, connection): the executor's
   * `listAllowedTools` view, translated to MCP tool definitions —
   * effect-derived annotations, and the ADR-0014 `[DEPRECATED …]` marker
   * on the projected description (deprecated actions stay advertised until
   * sunset). Empty for unknown connections.
   */
  async listTools(tenantId: string, connectionId: string): Promise<McpToolDefinition[]> {
    const actions = await this.executor.listAllowedTools(tenantId, connectionId);
    return actions.map((action) => this.toToolDefinition(action));
  }

  /** The tool definition for one action, or undefined when it is not visible. */
  async getTool(
    tenantId: string,
    connectionId: string,
    actionName: string,
  ): Promise<McpToolDefinition | undefined> {
    const actions = await this.executor.listAllowedTools(tenantId, connectionId);
    const action = actions.find((candidate) => candidate.name === actionName);
    return action === undefined ? undefined : this.toToolDefinition(action);
  }

  /**
   * Executes an action through the executor (Seam A): allowlist gate,
   * schema validation, audit row, unified error vocabulary (ADR-0005) all
   * apply. The caller is responsible for having resolved the tool first.
   */
  callTool(tenantId: string, connectionId: string, actionName: string, args: unknown): Promise<ActionResult> {
    return this.executor.executeAction(tenantId, connectionId, actionName, args);
  }

  /** The MCP wire projection of one visible action (the adapter's translation step). */
  private toToolDefinition(action: VisibleAction): McpToolDefinition {
    return {
      name: action.name,
      description: toolDescription(action),
      inputSchema: action.inputSchema,
      ...(annotationsFor(action.effects) !== undefined
        ? { annotations: annotationsFor(action.effects) }
        : {}),
    };
  }
}

/**
 * The tool description the adapter projects: the registry's stored
 * description, prefixed with the ADR-0014 deprecation marker on deprecated
 * actions — `[DEPRECATED — use <replacement>, sunset <date>]`, with
 * marker-only variants when replacement or sunset is absent. This is the
 * sole exception to ADR-0013's "descriptions carry no marking": deprecation
 * is time-varying state, not identity, and agents must see it at
 * tool-selection time. The stored description stays clean.
 */
function toolDescription(action: {
  description: string;
  deprecated?: ActionDeprecation;
}): string {
  const { deprecated } = action;
  if (deprecated === undefined) return action.description;
  if (deprecated.replacement !== undefined) {
    // Registration guarantees a sunset accompanies a replacement (ADR-0014).
    return `[DEPRECATED — use ${deprecated.replacement}, sunset ${deprecated.sunset}] ${action.description}`;
  }
  if (deprecated.sunset !== undefined) {
    return `[DEPRECATED — sunset ${deprecated.sunset}] ${action.description}`;
  }
  return `[DEPRECATED] ${action.description}`;
}

/**
 * Maps an action's effect class (T10) to MCP tool annotations. `read`
 * promises no state change (readOnlyHint); `destructive` signals
 * irreversible operations (destructiveHint); plain `write` is a mutation
 * that destroys nothing, so it carries no hints — it must not be marked
 * destructive.
 */
function annotationsFor(effects: ActionEffect): McpToolAnnotations | undefined {
  if (effects === 'read') return { readOnlyHint: true };
  if (effects === 'destructive') return { destructiveHint: true };
  return undefined;
}
