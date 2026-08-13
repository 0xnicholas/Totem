import { ActionError, errorMessage } from '../errors.js';
import type { ConnectionStateStore } from '../oauth/connection-state.js';
import {
  createUserTokenProvider,
  type TokenProvider,
  type UserTokenProfile,
} from '../oauth/token-lifecycle.js';
import type { TokenStore } from '../oauth/token-store.js';
import type { FeishuAppCredentials, FeishuCredsStore } from './creds-store.js';
import { FeishuApiError, type FeishuOAuthClient } from './oauth.js';

/**
 * The Feishu user-token adapter (ADR-0015): the provider-specific half of
 * the token lifecycle — credentials, the refresh call, and failure
 * classification. The lifecycle cell behind it owns fail-fast, decryption,
 * early refresh, single-flight, and write-back.
 */
export function createFeishuTokenProvider(deps: {
  tokenStore: TokenStore;
  credsStore: FeishuCredsStore;
  oauth: FeishuOAuthClient;
  connectionState: ConnectionStateStore;
  masterKey: string;
  now?: () => number;
  refreshWindowMs?: number;
}): TokenProvider {
  const profile: UserTokenProfile<FeishuAppCredentials> = {
    getCreds: (tenantId) => deps.credsStore.get(tenantId),

    refresh: (creds, refreshToken) => deps.oauth.refreshToken({ creds, refreshToken }),

    classifyRefreshError: (err) => {
      if (err instanceof ActionError) return { error: err };
      if (err instanceof FeishuApiError) {
        if (err.httpStatus === 429) {
          return {
            error: new ActionError('rate_limited', `Feishu rate limited during refresh: ${err.message}`),
          };
        }
        if (err.invalidGrant) {
          // The grant is dead: mark the connection so subsequent calls fail
          // fast and the operator knows re-auth is needed.
          return {
            error: new ActionError('auth_expired', `Feishu rejected the refresh token: ${err.message}`),
            mark: true,
          };
        }
      }
      return {
        error: new ActionError('upstream_error', `Feishu token refresh failed: ${errorMessage(err)}`),
      };
    },

    noCredsError: (tenantId) =>
      new ActionError(
        'auth_expired',
        `Tenant "${tenantId}" has no Feishu credentials configured; refresh impossible`,
      ),
  };

  return createUserTokenProvider(profile, deps);
}
