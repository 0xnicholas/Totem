import { Hono } from 'hono';
import { requireTenantKey } from '../auth.js';
import type { VisibleAction } from '../action.js';
import { isRecord } from '../admin/util.js';
import type { MCPKeyStore } from '../mcp/key-store.js';
import { toActionMetadata } from './action-metadata.js';

export interface DiscoveryAppConfig {
  /** The registry's visible view (`registry.visibleActions()`: hidden excluded, name-sorted); this surface translates only its wire format. */
  actions: VisibleAction[];
  /** Tenant actions-scope key resolution (the same store the MCP surface uses). */
  keys: MCPKeyStore;
}

/**
 * The read-only REST discovery surface (T12): makes the schema-first
 * registry programmatically discoverable without an agent — the first step
 * of the v2 REST surface per the StackOne protocol research (metadata +
 * search before any RPC envelope). Two routes:
 *
 * - `GET /actions` — the platform action set as metadata
 *   (name, description, effects), hidden actions excluded;
 * - `POST /actions/search` — case-insensitive text search across names and
 *   descriptions (semantic/embedding search is v2; substring matching is
 *   the documented v1 contract).
 *
 * Authenticated with a tenant actions-scope API key (Bearer), like the MCP
 * surface; no connection is involved — action metadata is platform-wide
 * (ADR-0001), not per-connection.
 *
 * The surface receives the registry's visible view (`VisibleAction[]`) and
 * projects only its wire format (ADR-0008): the hidden filter and the
 * advertised ordering live once in `ActionRegistry.visibleActions()`, and
 * the metadata shape lives once in `action-metadata.ts`.
 */
export function createDiscoveryApp(config: DiscoveryAppConfig): Hono {
  const { actions, keys } = config;
  const app = new Hono();

  app.get('/actions', requireTenantKey(keys), (c) => {
    return c.json({ actions: actions.map(toActionMetadata) });
  });

  app.post('/actions/search', requireTenantKey(keys), async (c) => {
    const body: unknown = await c.req.json().catch(() => undefined);
    const query = isRecord(body) && typeof body.query === 'string' ? body.query.trim() : '';
    if (query === '') {
      return c.json({ error: 'body must include a non-empty "query" string' }, 400);
    }
    const needle = query.toLowerCase();
    const matches = actions.filter(
      (action) =>
        action.name.toLowerCase().includes(needle) ||
        action.description.toLowerCase().includes(needle),
    );
    return c.json({ query, actions: matches.map(toActionMetadata) });
  });

  return app;
}
