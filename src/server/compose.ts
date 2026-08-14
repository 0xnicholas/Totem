import { Hono } from 'hono';
import pg from 'pg';
import { encryptValue } from '../crypto.js';
import { createAdminApp } from '../admin/server.js';
import { PostgresAdminRepository } from '../admin/pg-repo.js';
import { DingTalkConnector } from '../dingtalk/connector.js';
import { createDingTalkOAuthFlow } from '../dingtalk/flows.js';
import { createDingTalkOAuthClient } from '../dingtalk/oauth.js';
import { PostgresDingTalkCredsStore } from '../dingtalk/pg-creds-store.js';
import { createDingTalkTokenProvider } from '../dingtalk/tokens.js';
import { FeishuConnector } from '../feishu/connector.js';
import { createFeishuOAuthFlow } from '../feishu/flows.js';
import { createFeishuOAuthClient } from '../feishu/oauth.js';
import { PostgresFeishuCredsStore } from '../feishu/pg-creds-store.js';
import { createFeishuTokenProvider } from '../feishu/tokens.js';
import { PostgresConnectionStateStore } from '../oauth/pg-connection-state.js';
import { PostgresTokenStore } from '../oauth/pg-token-store.js';
import { createDiscoveryApp } from '../rest/discovery.js';
import { createOpenApiApp, DEFAULT_OPENAPI_META } from '../rest/openapi.js';
import { createRpcApp } from '../rest/rpc.js';
import { CONNECTION_ACTIONS, DOCS_ACTIONS, MESSAGING_ACTIONS, createActionExecutor, createMcpApp, McpAdapter, PostgresMCPKeyStore } from '../index.js';
import { PostgresConnectionStore } from '../pg-connections.js';
import { PostgresAllowlistStore, PostgresAuditPolicyStore, PostgresAuditSink, PostgresDefenderPolicyStore } from '../pg-governance.js';
import { TokenRoutingProvider } from '../token-routing.js';

export interface ServerEnv {
  /** Master key for per-tenant secret encryption (TOTEM_TOKEN_ENC_KEY). */
  masterKey: string;
  /** Bootstrap admin key for /admin routes (TOTEM_ADMIN_KEY). */
  adminKey: string;
  /** Key prefix: tt_live_ in production, tt_dev_ otherwise. */
  production?: boolean;
  /** Feishu Open Platform base URL (FEISHU_BASE_URL); defaults to open.feishu.cn. */
  feishuBaseUrl?: string;
  /** DingTalk API base URL (DINGTALK_API_BASE_URL); defaults to api.dingtalk.com. */
  dingtalkApiBaseUrl?: string;
  /** DingTalk authorize base URL (DINGTALK_AUTHORIZE_BASE_URL); defaults to login.dingtalk.com. */
  dingtalkAuthorizeBaseUrl?: string;
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
  const tokenManager = createFeishuTokenProvider({
    tokenStore,
    credsStore,
    oauth,
    connectionState: new PostgresConnectionStateStore(pool),
    masterKey,
  });
  const flow = createFeishuOAuthFlow({ credsStore, tokenStore, oauth, connections: repo, masterKey });

  // DingTalk (T17a): same wiring shape as Feishu — per-tenant app
  // credentials (encrypted), its own OAuth client + token provider + flow —
  // routed alongside Feishu by the composition root's token provider.
  const dingtalkApiBaseUrl = env.dingtalkApiBaseUrl ?? 'https://api.dingtalk.com';
  const dingtalkAuthorizeBaseUrl = env.dingtalkAuthorizeBaseUrl ?? 'https://login.dingtalk.com';
  const dingtalkOauth = createDingTalkOAuthClient({
    apiBaseUrl: dingtalkApiBaseUrl,
    authorizeBaseUrl: dingtalkAuthorizeBaseUrl,
  });
  const dingtalkCredsStore = new PostgresDingTalkCredsStore(pool, masterKey);
  const dingtalkTokenManager = createDingTalkTokenProvider({
    tokenStore,
    credsStore: dingtalkCredsStore,
    oauth: dingtalkOauth,
    connectionState: new PostgresConnectionStateStore(pool),
    masterKey,
  });
  const dingtalkFlow = createDingTalkOAuthFlow({
    credsStore: dingtalkCredsStore,
    tokenStore,
    oauth: dingtalkOauth,
    connections: repo,
    masterKey,
  });

  // The real Feishu Docs connector (T7) plus the DingTalk connector (T17a,
  // test_connection skeleton; doc actions in T17b/T17c). Both serve the
  // same platform action set; the executor dispatches by connection. The
  // DingTalk connector receives the app-token resolver (T17 live pass):
  // its doc/wiki/storage APIs authenticate with the app-level client-
  // credentials token, while ActionContext.token stays the user token for
  // the identity APIs.
  const connectors = [
    new FeishuConnector(feishuBaseUrl),
    new DingTalkConnector(dingtalkApiBaseUrl, {
      getAppAccessToken: (tenantId) => dingtalkTokenManager.getValidAppAccessToken(tenantId),
    }),
  ];
  const allowlists = new PostgresAllowlistStore(pool);
  const connectionLookup = new PostgresConnectionStore(pool);

  // The executor resolves connections live from Postgres, so connections
  // created by the OAuth flow (T6) are visible without a restart. Token
  // acquisition routes by connector id (T17a): one TokenProvider seam for
  // the executor, per-connector managers behind it.
  const executor = createActionExecutor({
    actions: [...DOCS_ACTIONS, ...MESSAGING_ACTIONS, ...CONNECTION_ACTIONS],
    connectors,
    connections: [],
    allowlists,
    audit: new PostgresAuditSink(pool),
    auditPolicy: new PostgresAuditPolicyStore(pool),
    tokenProvider: new TokenRoutingProvider(connectionLookup, {
      feishu_docs: tokenManager,
      dingtalk_docs: dingtalkTokenManager,
    }),
    connectionLookup,
    defenderPolicy: new PostgresDefenderPolicyStore(pool),
  });

  const adminApp = createAdminApp({
    repo,
    adminKey: env.adminKey,
    production: env.production ?? false,
    oauth: flow,
    dingtalkOauth: dingtalkFlow,
    secretCipher: {
      encrypt: (tenantId, secret) => encryptValue(tenantId, secret, masterKey),
    },
  });
  const mcpApp = createMcpApp({
    adapter: new McpAdapter(executor),
    keys: new PostgresMCPKeyStore(pool),
  });
  const discoveryApp = createDiscoveryApp({
    actions: executor.listVisibleActions(),
    keys: new PostgresMCPKeyStore(pool),
  });
  const rpcApp = createRpcApp({
    executor,
    keys: new PostgresMCPKeyStore(pool),
  });
  const openApiApp = createOpenApiApp({
    actions: executor.listVisibleActions(),
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
