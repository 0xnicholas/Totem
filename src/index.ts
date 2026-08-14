export type { Action, ActionContext, ActionDeprecation, ActionHandler, ActionEffect, ProviderToken, VisibleAction } from './action.js';
export { PROVIDER_TOKENS } from './action.js';
export { CONNECTION_ACTIONS, DOCS_ACTIONS, MESSAGING_ACTIONS } from './actions.js';
export type {
  AppendDocContentInput,
  AppendDocContentOutput,
  CellValue,
  CreateDocInput,
  CreateDocOutput,
  ExportDocInput,
  ExportDocOutput,
  GetDocContentInput,
  GetDocContentOutput,
  GetDocMetadataInput,
  GetDocMetadataOutput,
  MoveDocInput,
  MoveDocOutput,
  ReadBitableRecordsInput,
  ReadBitableRecordsOutput,
  ReadSheetCellsInput,
  ReadSheetCellsOutput,
  RenameDocInput,
  RenameDocOutput,
  SearchDocsInput,
  SearchDocsOutput,
  TestConnectionOutput,
  WriteBitableRecordsInput,
  WriteBitableRecordsOutput,
  WriteSheetCellsInput,
  WriteSheetCellsOutput,
} from './actions.js';
export type { ConnectorManifest, IConnector } from './connector.js';
export { ACTION_ERROR_CODES, ActionError, isActionError } from './errors.js';
export type { ActionErrorCode, ValidationIssue } from './errors.js';
export { DEFAULT_RATE_LIMIT_PER_MINUTE, RateLimiter } from './rate-limit.js';
export type { RateLimitDeclaration } from './rate-limit.js';
export { bearerToken, getCaller, getConnectionId, requireAdminKey, requireConnectionId, requireTenantKey } from './auth.js';
export { CALLER_KEY, CONNECTION_ID_KEY } from './auth.js';
export type { Caller } from './auth.js';
export { ActionRegistry } from './registry.js';
export { ActionExecutor, ConnectionStore, createActionExecutor } from './executor.js';
export type { ActionResult, ConnectionLookup, ConnectionRecord } from './executor.js';
export { PostgresConnectionStore } from './pg-connections.js';
export { PostgresAllowlistStore, PostgresAuditPolicyStore, PostgresAuditSink, PostgresDefenderPolicyStore } from './pg-governance.js';
export { McpAdapter } from './mcp/adapter.js';
export type { McpToolDefinition } from './mcp/adapter.js';
export { PostgresMCPKeyStore, loadConnections } from './mcp/pg-key-store.js';
export type { MCPKeyStore } from './mcp/key-store.js';
export { createMcpApp } from './mcp/server.js';
export type { McpAppConfig } from './mcp/server.js';
export { createDiscoveryApp } from './rest/discovery.js';
export type { DiscoveryAppConfig } from './rest/discovery.js';
export { actionMetadataSchema, toActionMetadata } from './rest/action-metadata.js';
export type { ActionMetadata } from './rest/action-metadata.js';
export { createRpcApp, STATUS_BY_ERROR_CODE } from './rest/rpc.js';
export type { RpcAppConfig } from './rest/rpc.js';
export { buildOpenApiDocument, buildPlatformOpenApiDocument, createOpenApiApp, DEFAULT_OPENAPI_META } from './rest/openapi.js';
export type { OpenApiAppConfig, OpenApiDocument, OpenApiMeta } from './rest/openapi.js';
export { InMemoryMCPKeyStore } from './testing/memory-key-store.js';
export { InMemoryDefenderPolicyStore } from './testing/memory-governance.js';
export { scanDefender, DEFENDER_MAX_RESPONSE_BYTES } from './defender.js';
export type { DefenderMetadata } from './defender.js';
export { decryptValue, deriveTenantKey, encryptValue, isCiphertext } from './crypto.js';
// The OAuth lifecycle module (ADR-0015): the platform-owned token + flow
// machinery; provider dirs contribute adapters.
export {
  DEFAULT_REFRESH_WINDOW_MS,
  createCachedTokenProvider,
  createUserTokenProvider,
} from './oauth/token-lifecycle.js';
export type {
  AppTokenProfile,
  CachedTokenProvider,
  ClassifiedRefreshFailure,
  TokenProvider,
  UserTokenProfile,
} from './oauth/token-lifecycle.js';
export { DEFAULT_STATE_TTL_MS, FlowError, createOAuthFlow } from './oauth/authorize-flow.js';
export type { AuthorizeProfile, ConnectionCreator, OAuthFlow } from './oauth/authorize-flow.js';
export type { StoredTokens, TokenStore } from './oauth/token-store.js';
export { PostgresTokenStore } from './oauth/pg-token-store.js';
export { PostgresConnectionStateStore } from './oauth/pg-connection-state.js';
export type { ConnectionStateStore } from './oauth/connection-state.js';
export type { FeishuAppCredentials, FeishuCredsStore } from './feishu/creds-store.js';
export { PostgresFeishuCredsStore } from './feishu/pg-creds-store.js';
export { FeishuApiError, createFeishuOAuthClient } from './feishu/oauth.js';
export { FeishuConnector, mapFeishuError } from './feishu/connector.js';
export type { FeishuOAuthClient, TokenPair } from './feishu/oauth.js';
export { createFeishuOAuthFlow } from './feishu/flows.js';
export { createFeishuTokenProvider } from './feishu/tokens.js';
export type { DingTalkAppCredentials, DingTalkCredsStore } from './dingtalk/creds-store.js';
export { PostgresDingTalkCredsStore } from './dingtalk/pg-creds-store.js';
export { DingTalkApiError, createDingTalkOAuthClient } from './dingtalk/oauth.js';
export type { DingTalkOAuthClient } from './dingtalk/oauth.js';
export { DingTalkConnector, mapDingtalkError } from './dingtalk/connector.js';
export { createDingTalkOAuthFlow } from './dingtalk/flows.js';
export { createDingTalkTokenProvider } from './dingtalk/tokens.js';
export type { DingTalkTokenProvider } from './dingtalk/tokens.js';
export { TokenRoutingProvider } from './token-routing.js';
export { createUpstreamHttp } from './upstream-http.js';
export type { UpstreamHttpProfile, UpstreamRequest, UpstreamRequestOptions } from './upstream-http.js';
export { MockDingTalkServer } from './testing/mock-dingtalk-server.js';
export type { MockDingTalkServerOptions } from './testing/mock-dingtalk-server.js';
export { InMemoryDingTalkCredsStore } from './testing/memory-dingtalk.js';
export { MockFeishuServer } from './testing/mock-feishu-server.js';
export type { MockFeishuDoc, MockFeishuServerOptions } from './testing/mock-feishu-server.js';
export { InMemoryFeishuCredsStore } from './testing/memory-feishu.js';
export { InMemoryConnectionStateStore, InMemoryTokenStore } from './testing/memory-oauth.js';
export { FAKE_CONNECTOR_ID, FakeConnector } from './testing/fake-connector.js';
export type { FakeDoc } from './testing/fake-connector.js';
