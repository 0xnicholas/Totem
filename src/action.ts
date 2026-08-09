import type { AnySchemaObject } from 'ajv';

/**
 * Context passed to connectors for a single execution. Exactly three things
 * per ADR-0003: `tenantId`, `connectionId`, and an already-valid access
 * token fetched by the orchestration layer (ADR-0004).
 */
export interface ActionContext {
  tenantId: string;
  connectionId: string;
  /**
   * Already-valid access token placed in the context by `executeAction`
   * (ADR-0004). Optional in T1: token infrastructure lands with the
   * TokenManager ticket, and the fake connector ignores it.
   */
  token?: string;
}

/**
 * A platform-defined action (ADR-0001): the registry is the single source of
 * truth for `name`, the agent-facing `description`, and the input/output
 * JSON Schemas. Connectors declare which actions they implement and
 * translate into the platform vocabulary; they never define actions
 * themselves.
 */
export interface Action {
  /** Lowercase snake_case name with a verb_noun shape, e.g. `create_doc`. */
  name: string;
  /** Agent-facing description; doubles as MCP tool documentation. */
  description: string;
  inputSchema: AnySchemaObject;
  outputSchema: AnySchemaObject;
}

/**
 * A connector's private implementation of a platform action (ADR-0003):
 * `handlers: Record<actionName, Handler>` lives inside the connector and is
 * never part of its interface.
 *
 * `Input`/`Output` default to `any` because a handler is a runtime value
 * whose schema types cannot be inferred from `unknown` at the boundary.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
export type ActionHandler<Input = any, Output = any> = (
  args: Input,
  ctx: ActionContext,
) => Output | Promise<Output>;
