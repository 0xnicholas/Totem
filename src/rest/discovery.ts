import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Action, ProviderToken } from '../action.js';
import { hashApiKey } from '../admin/keys.js';
import { isRecord } from '../admin/util.js';
import type { MCPKeyStore } from '../mcp/key-store.js';

export interface DiscoveryAppConfig {
  /** The platform action set (the registry's view; hidden actions are filtered here). */
  actions: Action[];
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
 */
export function createDiscoveryApp(config: DiscoveryAppConfig): Hono {
  const { actions, keys } = config;
  const visible = actions
    .filter((action) => action.hidden !== true)
    .sort((a, b) => a.name.localeCompare(b.name));
  const app = new Hono();

  async function authenticated(c: Context): Promise<boolean> {
    const header = c.req.header('authorization');
    const presented = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;
    if (!presented) return false;
    const resolved = await keys.findKey(hashApiKey(presented));
    return resolved !== undefined;
  }

  app.get('/actions', async (c) => {
    if (!(await authenticated(c))) return c.json({ error: 'unauthorized' }, 401);
    return c.json({ actions: visible.map(toMetadata) });
  });

  app.post('/actions/search', async (c) => {
    if (!(await authenticated(c))) return c.json({ error: 'unauthorized' }, 401);
    const body: unknown = await c.req.json().catch(() => undefined);
    const query = isRecord(body) && typeof body.query === 'string' ? body.query.trim() : '';
    if (query === '') {
      return c.json({ error: 'body must include a non-empty "query" string' }, 400);
    }
    const needle = query.toLowerCase();
    const matches = visible.filter(
      (action) =>
        action.name.toLowerCase().includes(needle) ||
        action.description.toLowerCase().includes(needle),
    );
    return c.json({ query, actions: matches.map(toMetadata) });
  });

  return app;
}

/**
 * The wire shape of one action on the discovery surface: name, description
 * and effects, plus `provider` on provider-native actions only (ADR-0013) —
 * canonical actions omit the key, so scope is additive and minor.
 */
export interface ActionMetadata {
  name: string;
  description: string;
  effects: string;
  provider?: ProviderToken;
}

function toMetadata(action: Action): ActionMetadata {
  const base: ActionMetadata = {
    name: action.name,
    description: action.description,
    effects: action.effects,
  };
  return action.provider !== undefined ? { ...base, provider: action.provider } : base;
}
