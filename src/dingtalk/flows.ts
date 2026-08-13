import {
  createOAuthFlow,
  type AuthorizeProfile,
  type ConnectionCreator,
  type OAuthFlow,
} from '../oauth/authorize-flow.js';
import type { TokenStore } from '../oauth/token-store.js';
import type { DingTalkAppCredentials, DingTalkCredsStore } from './creds-store.js';
import { DingTalkApiError, type DingTalkOAuthClient } from './oauth.js';

const DEFAULT_CONNECTOR_ID = 'dingtalk_docs';
const DEFAULT_CONNECTION_NAME = 'dingtalk';

/**
 * The DingTalk Authorize Flow adapter (ADR-0015): provider identity (the
 * dingtalk_docs connector, the connection name) plus the DingTalk-specific
 * profile — credentials, URL building (login.dingtalk.com), code exchange
 * (DingTalk binds the code to the client id, so no redirect_uri is sent),
 * and caller-error classification. The state machine behind it owns state
 * TTL and connection-first-then-tokens ordering.
 */
export function createDingTalkOAuthFlow(deps: {
  credsStore: DingTalkCredsStore;
  tokenStore: TokenStore;
  oauth: DingTalkOAuthClient;
  connections: ConnectionCreator;
  masterKey: string;
  connectorId?: string;
  connectionName?: string;
  stateTtlMs?: number;
  now?: () => number;
}): OAuthFlow {
  const profile: AuthorizeProfile<DingTalkAppCredentials> = {
    providerName: 'DingTalk',
    getCreds: (tenantId) => deps.credsStore.get(tenantId),
    noCredsMessage: (tenantId) =>
      `Tenant "${tenantId}" has no DingTalk credentials configured (set-dingtalk-creds)`,
    buildAuthorizationUrl: (creds, redirectUri, state) =>
      deps.oauth.buildAuthorizationUrl({ appKey: creds.appKey, redirectUri, state }),
    exchangeCode: (creds, code) => deps.oauth.exchangeCode({ creds, code }),
    isCallerError: (err) =>
      err instanceof DingTalkApiError && (err.invalidGrant || err.httpStatus === 429),
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
