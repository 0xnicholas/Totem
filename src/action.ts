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
 * The side-effect class of an action, declared by the platform so agents
 * can see the consequences of a call before making it (mapped to MCP tool
 * annotations at the adapter). `read` never changes state; `write` mutates
 * but nothing is permanently destroyed; `destructive` is irreversible
 * (deletion, overwrite of the object itself). Since the destructive family
 * (ADR-0018) the class carries a governance contract: acknowledged
 * allowlisting, fail-closed Defender input screening, always-audited
 * executions.
 */
export type ActionEffect = 'read' | 'write' | 'destructive';

/**
 * The provider tokens of the systems with connectors (ADR-0013): a small
 * closed union, extended only when a connector family is added — never an
 * open string registry. Provider-native action names carry `<token>_` as
 * their prefix, and a canonical action's name must not carry any of them.
 */
export const PROVIDER_TOKENS = ['feishu', 'dingtalk'] as const;

export type ProviderToken = (typeof PROVIDER_TOKENS)[number];

/**
 * The deprecation status of an action (ADR-0014): totem's action-level
 * policy, deliberately exceeding StackOne (which has none). Declaring a
 * `replacement` makes `sunset` required — the registry enforces that at
 * registration. The replacement need not be registered yet: deprecation
 * may precede the successor's landing. Until sunset the action stays
 * advertised and executable; removal at sunset is a major change and
 * follows the execution contract (ADR-0014 §2).
 */
export interface ActionDeprecation {
  /** The action agents should migrate to (e.g. the promoted canonical name). */
  replacement?: string;
  /** ISO date when removal happens (major change, execution contract). */
  sunset?: string;
  /** Human-readable migration guidance; surfaced through the discovery metadata. */
  note?: string;
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
  /**
   * The action's side-effect class (see `ActionEffect`). The registry
   * validates the value at registration; the MCP adapter maps it to tool
   * annotations.
   */
  effects: ActionEffect;
  /**
   * Hidden actions are registered, allowlistable and executable through
   * `executeAction`, but never advertised by MCP `tools/list` — the
   * platform-internal counterpart of ADR-0002's hide-don't-reject. Nothing
   * in the v1 set is hidden; the capability exists for platform-internal
   * actions.
   */
  hidden?: boolean;
  /**
   * Provider scope (ADR-0013). Present means provider-native: the name must
   * carry the `<provider>_` prefix and only connectors of this provider may
   * implement it. Absent means canonical: any connector may implement it,
   * and the name must not carry a known provider prefix. The registry
   * enforces both rules at registration, so scope is machine-checked, not
   * reviewer convention. Governance (allowlist, audit, Defender) treats
   * both kinds identically — scope limits availability and vocabulary only.
   */
  provider?: ProviderToken;
  /**
   * Deprecation status (ADR-0014). Present means the action is deprecated:
   * it stays advertised and executable until `sunset`, and the MCP adapter
   * prefixes its tool description with the `[DEPRECATED …]` marker at
   * listing time — the registry's stored description stays clean (the sole
   * exception to ADR-0013's "descriptions carry no marking"). Omitted for
   * non-deprecated actions.
   */
  deprecated?: ActionDeprecation;
}

/**
 * A Visible Action (CONTEXT.md): an Action with no `hidden` flag — the
 * registry's advertisement view, produced by
 * `ActionRegistry.visibleActions()` (hidden excluded, name-sorted) and
 * projected by every consumption surface. The type carries every field of
 * `Action` except `hidden`, so a caller holding a VisibleAction cannot even
 * read the flag — surfaces translate only their wire format (ADR-0008) and
 * can never re-derive the hidden rule.
 */
export type VisibleAction = Omit<Action, 'hidden'>;

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
