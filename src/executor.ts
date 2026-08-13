import type { Action, ActionContext, VisibleAction } from './action.js';
import { auditParamHash } from './audit.js';
import type { IConnector } from './connector.js';
import type { ActionErrorCode } from './errors.js';
import { ActionError, errorMessage, isActionError } from './errors.js';
import { scanDefender, type DefenderMetadata } from './defender.js';
import type { TokenProvider } from './oauth/token-lifecycle.js';
import {
  DEFAULT_DEFENDER_POLICY,
  type AllowlistStore,
  type AuditPolicyProvider,
  type AuditSink,
  type AuditSource,
  type DefenderPolicyProvider,
} from './governance.js';
import { DEFAULT_RATE_LIMIT_PER_MINUTE, RateLimiter } from './rate-limit.js';
import { ActionRegistry } from './registry.js';

/** A connection binds a tenant to a connector; identity is (tenantId, connectionId). */
export interface ConnectionRecord {
  tenantId: string;
  connectionId: string;
  connectorId: string;
}

/**
 * The executor's connection resolution seam: tenant-isolated lookup. The
 * in-memory `ConnectionStore` backs tests and the Postgres-backed store
 * backs the composed server, where the OAuth flow creates connections at
 * runtime (T6) — a static snapshot would never see them.
 */
export interface ConnectionLookup {
  get(tenantId: string, connectionId: string): Promise<ConnectionRecord | undefined>;
  list(): Promise<ConnectionRecord[]>;
}

/** In-memory `ConnectionLookup` for tests and local wiring. */
/* eslint-disable @typescript-eslint/require-await -- in-memory store: implements an async interface synchronously */
export class ConnectionStore implements ConnectionLookup {
  private readonly connections = new Map<string, ConnectionRecord>();

  constructor(connections: ConnectionRecord[]) {
    for (const record of connections) {
      const key = connectionKey(record.tenantId, record.connectionId);
      if (this.connections.has(key)) {
        throw new Error(
          `Duplicate connection "${record.connectionId}" for tenant "${record.tenantId}"`,
        );
      }
      this.connections.set(key, record);
    }
  }

  async get(tenantId: string, connectionId: string): Promise<ConnectionRecord | undefined> {
    return this.connections.get(connectionKey(tenantId, connectionId));
  }

  async list(): Promise<ConnectionRecord[]> {
    return [...this.connections.values()];
  }
}

/**
 * Unified result of an action execution. Either the handler's output
 * (validated against the action's output schema) or a structured
 * `ActionError` from the unified error vocabulary (ADR-0005).
 */
export type ActionResult =
  | { ok: true; output: unknown; defender?: DefenderMetadata }
  | { ok: false; error: ActionError };

/**
 * The action execution boundary (Seam A). All action calls — from MCP, the
 * admin API or tests — flow through here:
 *
 * 1. resolve the connection (tenant isolation enforced by the store)
 * 2. resolve the platform action definition in the registry
 * 3. check the connection's allowlist (fail-closed; `forbidden`)
 * 4. throttle against the connection's per-minute budget (T13; `rate_limited`
 *    with `retryAfterSeconds` — after the allowlist gate, so a forbidden call
 *    can never burn the bucket, and before validation/dispatch, which are the
 *    expensive parts)
 * 5. validate `args` against the action's input schema
 * 6. dispatch through the connection's connector (`execute`)
 * 7. validate the handler output against the action's output schema
 *
 * Every attempt on a resolvable connection writes an audit row (best
 * effort). Governance lives here per ADR-0003 — the connector only
 * translates.
 */
export class ActionExecutor {
  private readonly registry: ActionRegistry;
  private readonly connections: ConnectionLookup;
  private readonly allowlists: AllowlistStore;
  private readonly audit: AuditSink;
  private readonly tokenProvider?: TokenProvider;
  private readonly auditPolicy?: AuditPolicyProvider;
  private readonly rateLimiter: RateLimiter;
  private readonly defenderPolicy?: DefenderPolicyProvider;

  constructor(
    registry: ActionRegistry,
    connections: ConnectionLookup,
    allowlists: AllowlistStore,
    audit: AuditSink,
    tokenProvider?: TokenProvider,
    auditPolicy?: AuditPolicyProvider,
    rateLimiter?: RateLimiter,
    defenderPolicy?: DefenderPolicyProvider,
  ) {
    this.registry = registry;
    this.connections = connections;
    this.allowlists = allowlists;
    this.audit = audit;
    this.tokenProvider = tokenProvider;
    this.auditPolicy = auditPolicy;
    // Always-on by default: the throttle is the platform's fair-share
    // primitive, not an opt-in feature.
    this.rateLimiter = rateLimiter ?? new RateLimiter();
    this.defenderPolicy = defenderPolicy;
  }

  async executeAction(
    tenantId: string,
    connectionId: string,
    actionName: string,
    args: unknown,
    source: AuditSource = 'mcp',
  ): Promise<ActionResult> {
    const startedAt = Date.now();
    const connection = await this.connections.get(tenantId, connectionId);
    if (!connection) {
      // Unattributable attempt (no tenant row): audit_logs.tenant_id is a
      // NOT NULL foreign key, so no audit row can represent it.
      // ADR-0005 caps the vocabulary at seven codes with no orchestration-owned
      // "resource missing" code; `not_found` (retryable: false) is the closest
      // fit for an unknown connection. Revisit if the vocabulary grows.
      return {
        ok: false,
        error: new ActionError(
          'not_found',
          `Unknown connection "${connectionId}" for tenant "${tenantId}"`,
        ),
      };
    }

    const connector = this.registry.getConnector(connection.connectorId);
    // Guaranteed by the constructor wiring check; defensive for direct misuse.
    if (!connector) {
      await this.recordAudit(connection, actionName, args, source, 'not_found', startedAt);
      return {
        ok: false,
        error: new ActionError(
          'not_found',
          `Connector "${connection.connectorId}" for connection "${connectionId}" is not registered`,
        ),
      };
    }

    const action = this.registry.getAction(actionName);
    if (!action) {
      await this.recordAudit(connection, actionName, args, source, 'action_not_found', startedAt);
      return {
        ok: false,
        error: new ActionError('action_not_found', `Unknown action "${actionName}"`),
      };
    }

    // A connection's connector may implement only a subset of the platform
    // action set; calling the rest is a capability miss, not an upstream
    // failure (mirrors ADR-0002's hide-don't-reject stance).
    if (!connector.manifest.implements.includes(actionName)) {
      await this.recordAudit(connection, actionName, args, source, 'action_not_found', startedAt);
      return {
        ok: false,
        error: new ActionError(
          'action_not_found',
          `Action "${actionName}" is not available on connection "${connectionId}"`,
        ),
      };
    }

    // Allowlist gate (T4): fail-closed — an empty allowlist denies everything.
    // The check runs before input validation so a capability rejection is not
    // masked by a validation error.
    const allowed = await this.allowlists.getAllowedActions(tenantId, connectionId);
    if (!allowed.includes(actionName)) {
      await this.recordAudit(connection, actionName, args, source, 'forbidden', startedAt);
      return {
        ok: false,
        error: new ActionError(
          'forbidden',
          `Action "${actionName}" is not allowed on connection "${connectionId}"`,
        ),
      };
    }

    // Throttle gate (T13): one token bucket per (tenant, connection), budget
    // from the connector manifest (platform default when undeclared). A
    // denied attempt is a vocabulary error with the wait time the agent
    // should honor — the same signal shape a connector-mapped upstream 429
    // produces. Placed after the allowlist (a forbidden call must not burn
    // the bucket) and before validation/dispatch (the expensive parts).
    const requestsPerMinute =
      connector.manifest.rateLimit?.requestsPerMinute ?? DEFAULT_RATE_LIMIT_PER_MINUTE;
    const gate = this.rateLimiter.check(connectionKey(tenantId, connectionId), requestsPerMinute);
    if (!gate.allowed) {
      await this.recordAudit(connection, actionName, args, source, 'rate_limited', startedAt);
      return {
        ok: false,
        error: new ActionError(
          'rate_limited',
          `Rate limit exceeded for connection "${connectionId}" (${requestsPerMinute}/min)`,
          { retryAfterSeconds: gate.retryAfterSeconds },
        ),
      };
    }

    const inputIssues = this.registry.validateInput(actionName, args);
    if (inputIssues.length > 0) {
      await this.recordAudit(connection, actionName, args, source, 'validation_error', startedAt);
      return {
        ok: false,
        error: new ActionError('validation_error', `Invalid arguments for action "${actionName}"`, {
          details: inputIssues,
        }),
      };
    }

    // Token acquisition (ADR-0004): an already-valid access token is
    // fetched by the orchestration layer and placed in the context, so
    // connectors never see OAuth, refresh, or expiry. Acquisition failures
    // are vocabulary errors (auth_expired, rate_limited, ...) audited here
    // before any handler runs.
    let token: string | undefined;
    if (this.tokenProvider) {
      try {
        token = await this.tokenProvider.getValidAccessToken(connection.connectionId);
      } catch (err) {
        if (isActionError(err)) {
          await this.recordAudit(connection, actionName, args, source, err.code, startedAt);
          return { ok: false, error: err };
        }
        const cause = errorMessage(err);
        await this.recordAudit(connection, actionName, args, source, 'upstream_error', startedAt);
        return {
          ok: false,
          error: new ActionError('upstream_error', `Token acquisition failed: ${cause}`),
        };
      }
    }

    const ctx: ActionContext = { tenantId, connectionId, ...(token !== undefined ? { token } : {}) };
    let output: unknown;
    try {
      output = await connector.execute(actionName, args, ctx);
    } catch (err) {
      // Connector-mapped vocabulary errors pass through untouched (ADR-0005).
      if (isActionError(err)) {
        await this.recordAudit(connection, actionName, args, source, err.code, startedAt);
        return { ok: false, error: err };
      }
      const cause = errorMessage(err);
      await this.recordAudit(connection, actionName, args, source, 'upstream_error', startedAt);
      return {
        ok: false,
        error: new ActionError('upstream_error', `Action "${actionName}" failed: ${cause}`, {
          upstream: { code: 'unknown', message: cause },
        }),
      };
    }

    const outputIssues = this.registry.validateOutput(actionName, output);
    if (outputIssues.length > 0) {
      // A connector producing output outside the platform vocabulary is an
      // upstream failure from the caller's perspective (ADR-0005).
      await this.recordAudit(connection, actionName, args, source, 'upstream_error', startedAt);
      return {
        ok: false,
        error: new ActionError('upstream_error', `Invalid output from action "${actionName}"`, {
          details: outputIssues,
        }),
      };
    }

    // Defender tripwire (T15, ADR-0009): scan the unified output at the
    // return path, before it reaches the agent. Observe-first — scanning is
    // on by default (a policy lookup failure keeps the safe defaults), and
    // blocking is opt-in per tenant. Metadata rides the result and the
    // audit row (the observation path). Connectors stay pure translators:
    // the scan is a boundary concern, never inside a connector.
    let defender: DefenderMetadata | undefined;
    if (this.defenderPolicy) {
      let policy = DEFAULT_DEFENDER_POLICY;
      try {
        policy = await this.defenderPolicy.getPolicy(connection.tenantId);
      } catch (err) {
        console.error(`defender policy lookup failed: ${errorMessage(err)}`);
      }
      if (policy.enabled) {
        defender = scanDefender(output);
        if (defender && policy.blockHighRisk && defender.riskLevel === 'high') {
          const blockInfo = { reason: 'defender_block', ...defender };
          await this.recordAudit(connection, actionName, args, source, 'forbidden', startedAt, blockInfo);
          return {
            ok: false,
            error: new ActionError(
              'forbidden',
              'Response blocked: possible prompt injection detected',
              { details: blockInfo },
            ),
          };
        }
      }
    }

    await this.recordAudit(connection, actionName, args, source, null, startedAt, defender);
    return { ok: true, output, ...(defender !== undefined ? { defender } : {}) };
  }

  /**
   * Writes the audit row for an attempt on a resolved connection. Best
   * effort: a failing sink is logged and swallowed so an audit outage never
   * breaks the action layer. Tenants with an error-only policy (T11) skip
   * success rows; failures are always recorded.
   */
  private async recordAudit(
    connection: ConnectionRecord,
    actionName: string,
    args: unknown,
    source: AuditSource,
    errorCode: ActionErrorCode | null,
    startedAt: number,
    metadata?: unknown,
  ): Promise<void> {
    if (errorCode === null && this.auditPolicy) {
      try {
        const policy = await this.auditPolicy.getPolicy(connection.tenantId);
        if (policy.errorOnly) return;
      } catch (err) {
        // Policy lookup failure keeps the default (record everything): the
        // audit trail must never silently shrink on a store error.
        console.error(`audit policy lookup failed: ${errorMessage(err)}`);
      }
    }
    try {
      await this.audit.writeAudit({
        tenantId: connection.tenantId,
        connectionId: connection.connectionId,
        userId: null,
        actionName,
        paramHash: auditParamHash(args),
        source,
        success: errorCode === null,
        errorCode,
        durationMs: Date.now() - startedAt,
        createdAt: new Date().toISOString(),
        ...(metadata !== undefined ? { metadata } : {}),
      });
    } catch (err) {
      console.error(`audit write failed: ${errorMessage(err)}`);
    }
  }

  /** The registry's visible view (hidden excluded, name-sorted), for transport adapters. */
  listVisibleActions(): VisibleAction[] {
    return this.registry.visibleActions();
  }

  /**
   * Read-only connection resolution (tenant-isolated), for transport
   * adapters that must resolve the caller's connection before listing
   * tools (ADR-0002).
   */
  async getConnection(tenantId: string, connectionId: string): Promise<ConnectionRecord | undefined> {
    return this.connections.get(tenantId, connectionId);
  }

  /** Read-only connector lookup, for transport adapters (manifest reads). */
  getConnector(id: string): IConnector | undefined {
    return this.registry.getConnector(id);
  }
}

/**
 * Composition root for the action layer: registers the platform action set
 * and every connector into a fresh registry, then wires the connection
 * store. Fails fast on duplicate action names, invalid schemas,
 * naming-convention violations, manifests referencing unknown actions, and
 * dangling connection records.
 */
export function createActionExecutor(config: {
  actions: Action[];
  connectors: IConnector[];
  connections: ConnectionRecord[];
  allowlists: AllowlistStore;
  audit: AuditSink;
  tokenProvider?: TokenProvider;
  /** Tenant audit policies (T11): error-only mode. Optional — record everything. */
  auditPolicy?: AuditPolicyProvider;
  /** Live connection lookup (Postgres); defaults to an in-memory store over `connections`. */
  connectionLookup?: ConnectionLookup;
  /** Per-(tenant, connection) token buckets (T13); defaults to a real-clock limiter. */
  rateLimiter?: RateLimiter;
  /** Defender response screening (T15); optional — no provider, no scanning. */
  defenderPolicy?: DefenderPolicyProvider;
}): ActionExecutor {
  const registry = new ActionRegistry();
  for (const action of config.actions) registry.registerAction(action);
  for (const connector of config.connectors) registry.registerConnector(connector);
  // Wiring guard: every seeded connection must reference a registered
  // connector (fail fast on configuration errors). Postgres-backed
  // lookups bypass this and degrade gracefully at execution time.
  for (const record of config.connections) {
    if (!registry.getConnector(record.connectorId)) {
      throw new Error(`Connector "${record.connectorId}" is not registered`);
    }
  }
  return new ActionExecutor(
    registry,
    config.connectionLookup ?? new ConnectionStore(config.connections),
    config.allowlists,
    config.audit,
    config.tokenProvider,
    config.auditPolicy,
    config.rateLimiter,
    config.defenderPolicy,
  );
}

function connectionKey(tenantId: string, connectionId: string): string {
  return `${tenantId}\u0000${connectionId}`;
}
