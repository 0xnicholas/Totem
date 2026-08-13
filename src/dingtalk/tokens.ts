import { ActionError, errorMessage } from '../errors.js';
import type { ConnectionStateStore } from '../oauth/connection-state.js';
import {
  createCachedTokenProvider,
  createUserTokenProvider,
  type TokenProvider,
  type UserTokenProfile,
} from '../oauth/token-lifecycle.js';
import type { TokenStore } from '../oauth/token-store.js';
import type { DingTalkAppCredentials, DingTalkCredsStore } from './creds-store.js';
import { DingTalkApiError, type DingTalkOAuthClient } from './oauth.js';

/**
 * The DingTalk token adapter (ADR-0015): two cells over one profile family —
 *
 * - the **user token** (per connection, the ADR-0004 lifecycle): the same
 *   stored-token cell Feishu uses, with DingTalk's credentials, refresh
 *   call, and classification;
 * - the **app token** (per tenant, client credentials, T17 live pass): a
 *   cache-only cell — the doc/wiki/storage APIs authenticate with the app
 *   token plus the acting user's operatorId. A rejection here is an
 *   operator-credential problem, NOT the connection's user grant, so the
 *   connection is never poisoned with `auth_expired`.
 *
 * The executor only ever sees the user-token seam; `getValidAppAccessToken`
 * is exposed to the DingTalk connector alone.
 */
export interface DingTalkTokenProvider extends TokenProvider {
  getValidAppAccessToken(tenantId: string): Promise<string>;
}

export function createDingTalkTokenProvider(deps: {
  tokenStore: TokenStore;
  credsStore: DingTalkCredsStore;
  oauth: DingTalkOAuthClient;
  connectionState: ConnectionStateStore;
  masterKey: string;
  now?: () => number;
  refreshWindowMs?: number;
}): DingTalkTokenProvider {
  const profile: UserTokenProfile<DingTalkAppCredentials> = {
    getCreds: (tenantId) => deps.credsStore.get(tenantId),

    refresh: (creds, refreshToken) => deps.oauth.refreshToken({ creds, refreshToken }),

    classifyRefreshError: (err) => {
      if (err instanceof ActionError) return { error: err };
      if (err instanceof DingTalkApiError) {
        if (err.httpStatus === 429) {
          return {
            error: new ActionError('rate_limited', `DingTalk rate limited during refresh: ${err.message}`),
          };
        }
        if (err.invalidGrant) {
          // The grant is dead: mark the connection so subsequent calls fail
          // fast and the operator knows re-auth is needed.
          return {
            error: new ActionError('auth_expired', `DingTalk rejected the refresh token: ${err.message}`),
            mark: true,
          };
        }
      }
      return {
        error: new ActionError('upstream_error', `DingTalk token refresh failed: ${errorMessage(err)}`),
      };
    },

    noCredsError: (tenantId) =>
      new ActionError(
        'auth_expired',
        `Tenant "${tenantId}" has no DingTalk credentials configured; refresh impossible`,
      ),
  };

  const userTokens = createUserTokenProvider(profile, deps);

  const appTokens = createCachedTokenProvider(
    {
      fetch: async (tenantId) => {
        const creds = await deps.credsStore.get(tenantId);
        if (!creds) {
          throw new ActionError(
            'upstream_error',
            `Tenant "${tenantId}" has no DingTalk credentials configured; app token unavailable`,
          );
        }
        return deps.oauth.appAccessToken({ creds });
      },

      classifyFetchError: (err) => {
        // The no-creds ActionError thrown by fetch passes through untouched.
        if (err instanceof ActionError) return err;
        if (err instanceof DingTalkApiError) {
          if (err.httpStatus === 429) {
            return new ActionError(
              'rate_limited',
              `DingTalk rate limited during app-token fetch: ${err.message}`,
            );
          }
          return new ActionError('upstream_error', `DingTalk app-token fetch failed: ${err.message}`, {
            upstream: { code: err.code, message: err.message },
          });
        }
        return new ActionError('upstream_error', `DingTalk app-token fetch failed: ${errorMessage(err)}`);
      },
    },
    { refreshWindowMs: deps.refreshWindowMs, now: deps.now },
  );

  return {
    getValidAccessToken: (connectionId) => userTokens.getValidAccessToken(connectionId),
    getValidAppAccessToken: (tenantId) => appTokens.getValid(tenantId),
  };
}
