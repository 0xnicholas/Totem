import { Hono } from 'hono';
import type { Context } from 'hono';
import { hashApiKey } from '../admin/keys.js';
import { isRecord } from '../admin/util.js';
import type { ActionExecutor } from '../executor.js';
import type { ActionErrorCode } from '../errors.js';
import type { MCPKeyStore } from '../mcp/key-store.js';

export interface RpcAppConfig {
  /** The execution boundary (Seam A) — the RPC surface adds no action logic. */
  executor: ActionExecutor;
  /** Tenant actions-scope key resolution (the same store MCP and discovery use). */
  keys: MCPKeyStore;
}

/**
 * HTTP status for each ADR-0005 error code (T14). The body stays the
 * canonical `ActionErrorJson` everywhere; the status is the transport
 * signal. `auth_expired` maps to 401 like a credential failure (the
 * connection's token is invalid — re-authorize the connection, not the
 * key); `upstream_error` to 502 (the platform is a gateway to the real
 * system).
 */
export const STATUS_BY_ERROR_CODE = {
  validation_error: 400,
  action_not_found: 404,
  forbidden: 403,
  auth_expired: 401,
  not_found: 404,
  rate_limited: 429,
  upstream_error: 502,
} as const satisfies Record<ActionErrorCode, number>;

/**
 * The REST Actions RPC surface (T14, ADR-0008): `POST /actions/rpc` is the
 * non-agent consumption floor — CI, scheduled jobs, backend services. It is
 * a pure projection of `executeAction` (Seam A): same governance, same
 * audit, same error vocabulary — zero logic of its own.
 *
 * Envelope: `{action, args}` — `args` is the same flat object MCP
 * `tools/call` receives for the action (the registry's input schema), so
 * the two consumption surfaces can never diverge in parameter shape
 * (ADR-0008: "the registry is canonical; REST and MCP are both
 * projections"). Hidden actions are callable here — the direct-API path
 * (T10: hidden = not advertised, still executable; the allowlist still
 * gates at Seam A).
 *
 * Transport-level failures (auth, missing connection, malformed envelope)
 * are plain `{error}` 4xx responses; action-level failures are
 * `ActionErrorJson` bodies with `STATUS_BY_ERROR_CODE` status and a
 * `Retry-After` header when the error carries `retryAfterSeconds` (T13).
 */
export function createRpcApp(config: RpcAppConfig): Hono {
  const { executor, keys } = config;
  const app = new Hono();

  app.post('/actions/rpc', async (c) => {
    const tenantId = await resolveTenant(c, keys);
    if (!tenantId) return c.json({ error: 'unauthorized' }, 401);

    // Same per-request connection addressing as the MCP surface.
    const connectionId = c.req.header('x-connection-id') ?? c.req.query('x-connection-id');
    if (!connectionId) {
      return c.json({ error: 'missing x-connection-id (header or query param)' }, 400);
    }

    const body: unknown = await c.req.json().catch(() => undefined);
    const envelope = parseEnvelope(body);
    if (!envelope) {
      return c.json({ error: 'body must be {action: string, args?: object}' }, 400);
    }

    const result = await executor.executeAction(
      tenantId,
      connectionId,
      envelope.action,
      envelope.args,
    );
    if (result.ok) return c.json(result.output);

    if (result.error.retryAfterSeconds !== undefined) {
      c.header('retry-after', String(result.error.retryAfterSeconds));
    }
    return c.json(result.error.toJSON(), STATUS_BY_ERROR_CODE[result.error.code]);
  });

  return app;
}

/** Authenticates a tenant actions-scope key; undefined → 401 (like MCP/discovery). */
async function resolveTenant(c: Context, keys: MCPKeyStore): Promise<string | undefined> {
  const header = c.req.header('authorization');
  const presented = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;
  if (!presented) return undefined;
  const resolved = await keys.findKey(hashApiKey(presented));
  return resolved?.tenantId;
}

/**
 * The RPC envelope: `{action, args}`. `action` must be a non-empty string;
 * `args` is optional (defaults to `{}`) and must be an object when present.
 * Envelope-shape violations are transport errors — they never reach the
 * executor.
 */
function parseEnvelope(body: unknown): { action: string; args: unknown } | undefined {
  if (!isRecord(body)) return undefined;
  if (typeof body.action !== 'string' || body.action === '') return undefined;
  if (body.args !== undefined && !isRecord(body.args)) return undefined;
  return { action: body.action, args: body.args ?? {} };
}
