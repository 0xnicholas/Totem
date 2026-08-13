import {
  createOAuthFlow,
  type AuthorizeProfile,
  type ConnectionCreator,
  type OAuthFlow,
} from '../oauth/authorize-flow.js';
import type { TokenStore } from '../oauth/token-store.js';
import type { FeishuAppCredentials, FeishuCredsStore } from './creds-store.js';
import { FeishuApiError, type FeishuOAuthClient } from './oauth.js';

const DEFAULT_CONNECTOR_ID = 'feishu_docs';
const DEFAULT_CONNECTION_NAME = 'feishu';

/**
 * The Feishu Authorize Flow adapter (ADR-0015): provider identity (the
 * feishu_docs connector, the connection name) plus the Feishu-specific
 * profile — credentials, URL building, code exchange (redirect_uri bound
 * to the code), and caller-error classification. The state machine behind
 * it owns state TTL and connection-first-then-tokens ordering.
 */
export function createFeishuOAuthFlow(deps: {
  credsStore: FeishuCredsStore;
  tokenStore: TokenStore;
  oauth: FeishuOAuthClient;
  connections: ConnectionCreator;
  masterKey: string;
  connectorId?: string;
  connectionName?: string;
  stateTtlMs?: number;
  now?: () => number;
}): OAuthFlow {
  const profile: AuthorizeProfile<FeishuAppCredentials> = {
    providerName: 'Feishu',
    getCreds: (tenantId) => deps.credsStore.get(tenantId),
    noCredsMessage: (tenantId) =>
      `Tenant "${tenantId}" has no Feishu credentials configured (set-feishu-creds)`,
    buildAuthorizationUrl: (creds, redirectUri, state) =>
      deps.oauth.buildAuthorizationUrl({ appId: creds.appId, redirectUri, state }),
    exchangeCode: (creds, code, redirectUri) =>
      deps.oauth.exchangeCode({ creds, code, redirectUri }),
    isCallerError: (err) =>
      err instanceof FeishuApiError && (err.invalidGrant || err.httpStatus === 429),
  };

  return createOAuthFlow(profile, {
    tokenStore: deps.tokenStore,
    connections: deps.connections,
    masterKey: deps.masterKey,
    connectorId: deps.connectorId ?? DEFAULT_CONNECTOR_ID,
    connectionName: deps.connectionName ?? DEFAULT_CONNECTION_NAME,
    stateTtlMs: deps.stateTtlMs,
    now: deps.now,
  });
}
