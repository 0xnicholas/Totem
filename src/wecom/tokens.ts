import { ActionError, errorMessage } from '../errors.js';
import type { ConnectionLookup } from '../executor.js';
import {
  createCachedTokenProvider,
  type TokenProvider,
} from '../oauth/token-lifecycle.js';
import type { WeComCredsStore } from './creds-store.js';
import { WeComApiError, type WeComOAuthClient } from './oauth.js';

/**
 * The WeCom token adapter (ADR-0017): the credential-connection cell.
 * ONE cell, no user tokens — WeCom self-built apps have no OAuth, so the
 * connection's token is the app-level access token served by the cached
 * cell (`createCachedTokenProvider`: fetch on miss/expiry, single-flight,
 * in-memory per tenant, never marks auth-expired).
 *
 * The executor's seam is `getValidAccessToken(connectionId)`; the cell and
 * the creds store are keyed by tenant, so this adapter owns the
 * connection→tenant resolution (the same indexed lookup the routing
 * provider performs for connector dispatch).
 */
export function createWeComTokenProvider(deps: {
  connections: ConnectionLookup;
  credsStore: WeComCredsStore;
  oauth: WeComOAuthClient;
  now?: () => number;
  refreshWindowMs?: number;
}): TokenProvider {
  const appTokens = createCachedTokenProvider(
    {
      fetch: async (tenantId) => {
        const creds = await deps.credsStore.get(tenantId);
        if (!creds) {
          throw new ActionError(
            'upstream_error',
            `Tenant "${tenantId}" has no WeCom credentials configured; access token unavailable`,
          );
        }
        return deps.oauth.appAccessToken({ creds });
      },

      classifyFetchError: (err) => {
        // The no-creds ActionError thrown by fetch passes through untouched.
        if (err instanceof ActionError) return err;
        if (err instanceof WeComApiError) {
          if (err.httpStatus === 429) {
            return new ActionError(
              'rate_limited',
              `WeCom rate limited during gettoken: ${err.message}`,
            );
          }
          // ADR-0017: a failed gettoken is an operator-credential problem
          // (rotated secret, wrong corpid) — the connection is a credential
          // connection, there is no user grant to expire, so this is and
          // stays upstream_error. Never auth_expired, never marked.
          return new ActionError(
            'upstream_error',
            `WeCom gettoken failed (errcode ${err.errcode}): ${err.message}`,
            { upstream: { code: String(err.errcode), message: err.message } },
          );
        }
        return new ActionError(
          'upstream_error',
          `WeCom access-token fetch failed: ${errorMessage(err)}`,
        );
      },
    },
    { refreshWindowMs: deps.refreshWindowMs, now: deps.now },
  );

  return {
    async getValidAccessToken(connectionId: string): Promise<string> {
      const record = await deps.connections.getByConnectionId(connectionId);
      if (!record) {
        throw new ActionError(
          'upstream_error',
          `Connection "${connectionId}" not found during token acquisition`,
        );
      }
      return appTokens.getValid(record.tenantId);
    },
  };
}
