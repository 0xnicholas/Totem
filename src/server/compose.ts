import { Hono } from 'hono';
import pg from 'pg';
import { createAdminApp } from '../admin/server.js';
import { PostgresAdminRepository } from '../admin/pg-repo.js';
import { FeishuConnector } from '../feishu/connector.js';
import { encryptValue } from '../feishu/crypto.js';
import { createOAuthFlow } from '../feishu/flow.js';
import { createFeishuOAuthClient } from '../feishu/oauth.js';
import { PostgresConnectionStateStore } from '../feishu/pg-connection-state.js';
import { PostgresFeishuCredsStore } from '../feishu/pg-creds-store.js';
import { PostgresTokenStore } from '../feishu/pg-token-store.js';
import { TokenManager } from '../feishu/token-manager.js';
import { createDiscoveryApp } from '../rest/discovery.js';
import { createOpenApiApp, DEFAULT_OPENAPI_META } from '../rest/openapi.js';
import { createRpcApp } from '../rest/rpc.js';
import { CONNECTION_ACTIONS, DOCS_ACTIONS, createActionExecutor, createMcpApp, McpAdapter, PostgresMCPKeyStore } from '../index.js';
import { PostgresConnectionStore } from '../pg-connections.js';
import { PostgresAllowlistStore, PostgresAuditPolicyStore, PostgresAuditSink, PostgresDefenderPolicyStore } from '../pg-governance.js';

export interface ServerEnv {
  /** Master key for per-tenant secret encryption (TOTEM_TOKEN_ENC_KEY). */
  masterKey: string;
  /** Bootstrap admin key for /admin routes (TOTEM_ADMIN_KEY). */
  adminKey: string;
  /** Key prefix: tt_live_ in production, tt_dev_ otherwise. */
  production?: boolean;
  /** Feishu Open Platform base URL (FEISHU_BASE_URL); defaults to open.feishu.cn. */
  feishuBaseUrl?: string;
  /** Public base URL of this deployment (TOTEM_URL); mirrored into the OpenAPI document. */
  serverUrl?: string;
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
  const feishuBaseUrl = env.feishuBaseUrl ?? 'https://open.feishu.cn';
  const oauth = createFeishuOAuthClient(feishuBaseUrl);

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

  // The real Feishu Docs connector (T7): read actions live; T8-T9 add the
  // write/export/sheet/bitable actions to this same connector.
  const connectors = [new FeishuConnector(feishuBaseUrl)];
  const allowlists = new PostgresAllowlistStore(pool);

  // The executor resolves connections live from Postgres, so connections
  // created by the OAuth flow (T6) are visible without a restart.
  const executor = createActionExecutor({
    actions: [...DOCS_ACTIONS, ...CONNECTION_ACTIONS],
    connectors,
    connections: [],
    allowlists,
    audit: new PostgresAuditSink(pool),
    auditPolicy: new PostgresAuditPolicyStore(pool),
    tokenProvider: tokenManager,
    connectionLookup: new PostgresConnectionStore(pool),
    defenderPolicy: new PostgresDefenderPolicyStore(pool),
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
  const discoveryApp = createDiscoveryApp({
    actions: executor.listActions(),
    keys: new PostgresMCPKeyStore(pool),
  });
  const rpcApp = createRpcApp({
    executor,
    keys: new PostgresMCPKeyStore(pool),
  });
  const openApiApp = createOpenApiApp({
    actions: executor.listActions(),
    meta: {
      ...DEFAULT_OPENAPI_META,
      serverUrl: env.serverUrl ?? DEFAULT_OPENAPI_META.serverUrl,
    },
  });

  const app = new Hono();
  app.route('/', adminApp);
  app.route('/mcp', mcpApp);
  app.route('/', discoveryApp);
  app.route('/', rpcApp);
  app.route('/', openApiApp);
  app.notFound((c) => c.json({ error: 'route not found' }, 404));
  app.onError((err, c) => {
    console.error(err);
    return c.json({ error: 'internal_error' }, 500);
  });
  return app;
}
