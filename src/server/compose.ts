import { Hono } from 'hono';
import pg from 'pg';
import type { ActionContext } from '../action.js';
import type { IConnector } from '../connector.js';
import { createAdminApp } from '../admin/server.js';
import { PostgresAdminRepository } from '../admin/pg-repo.js';
import { encryptValue } from '../feishu/crypto.js';
import { createOAuthFlow } from '../feishu/flow.js';
import { createFeishuOAuthClient } from '../feishu/oauth.js';
import { PostgresConnectionStateStore } from '../feishu/pg-connection-state.js';
import { PostgresFeishuCredsStore } from '../feishu/pg-creds-store.js';
import { PostgresTokenStore } from '../feishu/pg-token-store.js';
import { TokenManager } from '../feishu/token-manager.js';
import { DOCS_ACTIONS, createActionExecutor, createMcpApp, McpAdapter, PostgresMCPKeyStore } from '../index.js';
import { PostgresConnectionStore } from '../pg-connections.js';
import { PostgresAllowlistStore, PostgresAuditSink } from '../pg-governance.js';
import { FakeConnector } from '../testing/fake-connector.js';

export interface ServerEnv {
  /** Master key for per-tenant secret encryption (TOTEM_TOKEN_ENC_KEY). */
  masterKey: string;
  /** Bootstrap admin key for /admin routes (TOTEM_ADMIN_KEY). */
  adminKey: string;
  /** Key prefix: tt_live_ in production, tt_dev_ otherwise. */
  production?: boolean;
  /** Feishu Open Platform base URL (FEISHU_BASE_URL); defaults to open.feishu.cn. */
  feishuBaseUrl?: string;
}

/**
 * The v1 composition root: one process, one port — the operator surface
 * (/admin), the agent surface (/mcp, Streamable HTTP) and the public OAuth
 * callback. All stores are Postgres-backed; secrets are encrypted at rest
 * with the per-tenant key (ADR-0004, issue #15). Extracted from the entry
 * so the e2e tests drive exactly the production wiring.
 */
export function composeServer(pool: pg.Pool, env: ServerEnv): Hono {
  const repo = new PostgresAdminRepository(pool);
  const masterKey = env.masterKey;
  const oauth = createFeishuOAuthClient(env.feishuBaseUrl ?? 'https://open.feishu.cn');

  const credsStore = new PostgresFeishuCredsStore(pool, masterKey);
  const tokenStore = new PostgresTokenStore(pool);
  const tokenManager = new TokenManager({
    tokenStore,
    credsStore,
    oauth,
    connectionState: new PostgresConnectionStateStore(pool),
    masterKey,
  });
  const flow = createOAuthFlow({ credsStore, tokenStore, oauth, connections: repo, masterKey });

  // v1 ships exactly one connector implementation: the in-memory fake used
  // for local demos and the integration story. It is registered under the
  // Feishu connector id so connections created by the OAuth flow can
  // execute through the whole stack; T7-T9 replace this wrapper with the
  // real Feishu Docs connector, and the wiring below does not change.
  const connectors: IConnector[] = [new FeishuDocsConnector()];
  const allowlists = new PostgresAllowlistStore(pool);

  // The executor resolves connections live from Postgres, so connections
  // created by the OAuth flow (T6) are visible without a restart.
  const executor = createActionExecutor({
    actions: DOCS_ACTIONS,
    connectors,
    connections: [],
    allowlists,
    audit: new PostgresAuditSink(pool),
    tokenProvider: tokenManager,
    connectionLookup: new PostgresConnectionStore(pool),
  });

  const adminApp = createAdminApp({
    repo,
    adminKey: env.adminKey,
    production: env.production ?? false,
    oauth: flow,
    secretCipher: {
      encrypt: (tenantId, secret) => encryptValue(tenantId, secret, masterKey),
    },
  });
  const mcpApp = createMcpApp({
    adapter: new McpAdapter(executor, allowlists),
    keys: new PostgresMCPKeyStore(pool),
  });

  const app = new Hono();
  app.route('/', adminApp);
  app.route('/mcp', mcpApp);
  app.notFound((c) => c.json({ error: 'route not found' }, 404));
  app.onError((err, c) => {
    console.error(err);
    return c.json({ error: 'internal_error' }, 500);
  });
  return app;
}

/**
 * Temporary v1 stand-in: the in-memory fake connector exposed under the
 * `feishu_docs` connector id, so OAuth-created connections work end to end
 * until the real Feishu connector lands (T7-T9).
 */
class FeishuDocsConnector implements IConnector {
  readonly manifest = { id: 'feishu_docs', implements: ['create_doc', 'read_doc', 'list_docs'] };
  private readonly inner = new FakeConnector();

  execute(action: string, args: unknown, ctx: ActionContext): Promise<unknown> {
    return this.inner.execute(action, args, ctx);
  }
}
