import type { ActionContext } from './action.js';

/**
 * Connector manifest (ADR-0001): the connector declares its identity and the
 * platform actions it implements. The action list is derived from this — the
 * connector has no separate `listActions` method (ADR-0003).
 */
export interface ConnectorManifest {
  /** Stable identifier used by connection records, e.g. `feishu_docs`. */
  id: string;
  /** Names of platform actions this connector implements. */
  implements: string[];
}

/**
 * Pluggable adapter contract (ADR-0003): a connector is a pure translator —
 * unified args → system request, system response → unified output, system
 * errors → the unified error vocabulary. It never touches the database,
 * audit, allowlists or config stores; governance lives in `executeAction`.
 */
export interface IConnector {
  readonly manifest: ConnectorManifest;
  execute(action: string, args: unknown, ctx: ActionContext): Promise<unknown>;
}
