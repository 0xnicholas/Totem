import { createHash, timingSafeEqual } from 'node:crypto';
import type { Context, MiddlewareHandler } from 'hono';
import { hashApiKey } from './admin/keys.js';
import type { AdminRepository } from './admin/repo.js';
import type { MCPKeyStore } from './mcp/key-store.js';

/**
 * The platform's tenant-key auth module: one implementation of caller
 * identity for every HTTP surface. The consumer surfaces (MCP, RPC,
 * discovery) authenticate actions-scoped tenant keys; the admin surface
 * authenticates the bootstrap admin key or an admin-scoped tenant key.
 * Scope and disabled-state semantics stay in the key stores (the WHERE
 * clauses / the in-memory double) — this module only parses, hashes,
 * resolves, and gates.
 */

/** The resolved caller attached to the Hono context by `requireTenantKey`. */
export interface Caller {
  tenantId: string;
  keyId: string;
  /** The raw Bearer token as presented — the MCP surface needs it for authInfo. */
  presented: string;
}

export const CALLER_KEY = 'caller' as const;
export const CONNECTION_ID_KEY = 'connectionId' as const;

/** The resolved caller attached by `requireTenantKey` (typed read). */
export function getCaller(c: Context): Caller {
  return c.get(CALLER_KEY) as Caller;
}

/** The connection id attached by `requireConnectionId` (typed read). */
export function getConnectionId(c: Context): string {
  return c.get(CONNECTION_ID_KEY) as string;
}

/** The Bearer token of a request, or undefined when absent/malformed. */
export function bearerToken(c: Context): string | undefined {
  const header = c.req.header('authorization');
  return header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;
}

/**
 * Resolves an enabled actions-scoped tenant key (scope enforced by the
 * store) and attaches the caller to the context — or 401s. One middleware,
 * every consumer surface: a key-format or lookup change happens here once.
 */
export function requireTenantKey(keys: MCPKeyStore): MiddlewareHandler {
  return async (c, next) => {
    const presented = bearerToken(c);
    if (!presented) return c.json({ error: 'unauthorized' }, 401);
    const resolved = await keys.findKey(hashApiKey(presented));
    if (!resolved) return c.json({ error: 'unauthorized' }, 401);
    c.set(CALLER_KEY, { ...resolved, presented } satisfies Caller);
    await next();
  };
}

/**
 * Resolves the per-request connection address (`x-connection-id` header,
 * query-param fallback) and attaches it to the context — or 400s when
 * absent. The same addressing the MCP and RPC surfaces perform.
 */
export function requireConnectionId(): MiddlewareHandler {
  return async (c, next) => {
    const connectionId = c.req.header('x-connection-id') ?? c.req.query('x-connection-id');
    if (!connectionId) {
      return c.json({ error: 'missing x-connection-id (header or query param)' }, 400);
    }
    c.set(CONNECTION_ID_KEY, connectionId);
    await next();
  };
}

/**
 * The admin gate: the bootstrap admin key (env `TOTEM_ADMIN_KEY`, compared
 * constant-time against its SHA-256) or any enabled admin-scoped tenant
 * key. Gate-only — no caller context is attached (no admin route reads one;
 * the repository records the audit source itself).
 */
export function requireAdminKey(deps: {
  adminKey: string;
  repo: Pick<AdminRepository, 'findAdminKey'>;
}): MiddlewareHandler {
  const adminKeyHash = createHash('sha256').update(deps.adminKey).digest();
  return async (c, next) => {
    const presented = bearerToken(c);
    if (!presented) return c.json({ error: 'unauthorized' }, 401);
    const presentedHash = createHash('sha256').update(presented).digest();
    if (timingSafeEqual(presentedHash, adminKeyHash)) {
      await next();
      return;
    }
    // Admin-scoped tenant keys are also admin credentials (T3 amendment).
    const key = await deps.repo.findAdminKey(hashApiKey(presented));
    if (!key) return c.json({ error: 'unauthorized' }, 401);
    await next();
  };
}
