import { ActionError, errorMessage } from '../errors.js';
import { decryptValue, encryptValue } from '../crypto.js';
import type { ConnectionStateStore } from './connection-state.js';
import type { StoredTokens, TokenStore } from './token-store.js';

/**
 * The token acquisition contract the orchestration layer depends on
 * (ADR-0004): one method, everything else hidden behind it. Provider
 * adapters (feishu, dingtalk) satisfy this interface by composing the
 * lifecycle cells below; the executor never knows which provider made the
 * token.
 */
export interface TokenProvider {
  getValidAccessToken(connectionId: string): Promise<string>;
}

/** Refresh when the remaining validity drops below this (ADR-0004: early refresh). */
export const DEFAULT_REFRESH_WINDOW_MS = 5 * 60 * 1000;

/** A fresh pair as returned by a provider's refresh call. */
export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  /** ISO timestamp when the access token expires. */
  expiresAt: string;
}

/** A classified refresh failure: the vocabulary error plus an optional marking side effect. */
export interface ClassifiedRefreshFailure {
  error: ActionError;
  /** Mark the connection `auth_expired` (best effort) before throwing. */
  mark?: boolean;
}

/**
 * The provider-specific half of the user-token lifecycle — the adapter
 * side of the seam (ADR-0015): credentials, the refresh call, and failure
 * classification. Everything subtle (fail-fast, decryption, the
 * early-refresh window, single-flight, write-back, best-effort marking)
 * lives in the cell behind this profile.
 */
export interface UserTokenProfile<TCreds> {
  /** Reads the tenant's app credentials; undefined means the tenant never configured them. */
  getCreds(tenantId: string): Promise<TCreds | undefined>;
  /** The provider's refresh call (already provider-shaped by its oauth client). */
  refresh(creds: TCreds, refreshToken: string): Promise<TokenPair>;
  /** Maps a refresh failure into the unified vocabulary; `mark` requests the dead-grant marking. */
  classifyRefreshError(err: unknown): ClassifiedRefreshFailure | Promise<ClassifiedRefreshFailure>;
  /** The error thrown when the tenant has no credentials (refresh is impossible). */
  noCredsError(tenantId: string): ActionError;
}

/**
 * The user-token lifecycle cell (ADR-0004, ADR-0015): the whole OAuth
 * token lifecycle behind one method —
 *
 * - fail-fast when the connection is already marked `auth_expired`;
 * - encrypted read from the token store (per-tenant derived key);
 * - **early refresh** when remaining validity < the refresh window, so a
 *   token never dies mid-call;
 * - **single-flight refresh**: concurrent calls for one connection share a
 *   single in-flight refresh promise — exactly one refresh hits upstream;
 * - **atomic write-back** of the refreshed pair (one upsert statement);
 * - **best-effort marking** when the classifier reports a dead grant —
 *   a failed mark must not change the error the caller sees.
 *
 * Provider adapters instantiate this once per token kind they serve.
 * Connectors never see any of it: they receive an already-valid token in
 * `ActionContext.token`.
 */
export function createUserTokenProvider<TCreds>(
  profile: UserTokenProfile<TCreds>,
  deps: {
    tokenStore: TokenStore;
    connectionState: ConnectionStateStore;
    masterKey: string;
    refreshWindowMs?: number;
    now?: () => number;
  },
): TokenProvider {
  const refreshes = new Map<string, Promise<string>>();
  const now = deps.now ?? Date.now;
  const refreshWindowMs = deps.refreshWindowMs ?? DEFAULT_REFRESH_WINDOW_MS;

  async function getValidAccessToken(connectionId: string): Promise<string> {
    // Fail fast once a dead grant has marked the connection (ADR-0004):
    // no point touching the token store or the provider until re-auth.
    if ((await deps.connectionState.getStatus(connectionId)) === 'auth_expired') {
      throw new ActionError(
        'auth_expired',
        `Connection "${connectionId}" needs re-authorization (refresh token rejected)`,
      );
    }

    const stored = await deps.tokenStore.get(connectionId);
    if (!stored) {
      throw new ActionError(
        'auth_expired',
        `Connection "${connectionId}" has no stored tokens; run the OAuth flow first`,
      );
    }

    let accessToken: string;
    try {
      accessToken = decryptValue(stored.tenantId, stored.accessTokenCiphertext, deps.masterKey);
    } catch (err) {
      throw new ActionError(
        'upstream_error',
        `Stored access token could not be decrypted: ${errorMessage(err)}`,
      );
    }
    if (new Date(stored.expiresAt).getTime() - now() > refreshWindowMs) {
      return accessToken;
    }
    return refresh(connectionId, stored);
  }

  /** Single-flight: one in-flight refresh promise per connection. */
  function refresh(connectionId: string, stored: StoredTokens): Promise<string> {
    const inflight = refreshes.get(connectionId);
    if (inflight) return inflight;
    const pending = doRefresh(connectionId, stored).finally(() => {
      refreshes.delete(connectionId);
    });
    refreshes.set(connectionId, pending);
    return pending;
  }

  async function doRefresh(connectionId: string, stored: StoredTokens): Promise<string> {
    const creds = await profile.getCreds(stored.tenantId);
    if (!creds) throw profile.noCredsError(stored.tenantId);

    try {
      const refreshToken = decryptValue(
        stored.tenantId,
        stored.refreshTokenCiphertext,
        deps.masterKey,
      );
      const pair = await profile.refresh(creds, refreshToken);
      await deps.tokenStore.upsert({
        tenantId: stored.tenantId,
        connectionId,
        accessTokenCiphertext: encryptValue(stored.tenantId, pair.accessToken, deps.masterKey),
        refreshTokenCiphertext: encryptValue(
          stored.tenantId,
          pair.refreshToken,
          deps.masterKey,
        ),
        expiresAt: pair.expiresAt,
      });
      return pair.accessToken;
    } catch (err) {
      const failure = await profile.classifyRefreshError(err);
      if (failure.mark) {
        await deps.connectionState.markAuthExpired(connectionId).catch((markErr: unknown) => {
          console.error(
            `markAuthExpired failed for connection ${connectionId}: ${errorMessage(markErr)}`,
          );
        });
      }
      throw failure.error;
    }
  }

  return { getValidAccessToken };
}

/**
 * The provider-specific half of the app-level token lifecycle (ADR-0015):
 * a client-credentials fetch plus its failure classification. App tokens
 * are operator-credential tokens, not user grants — there is no store, no
 * fail-fast, and no connection marking; the cell caches in memory only.
 */
export interface AppTokenProfile {
  /** Fetches a fresh app-level token for the cell key (a tenant id). */
  fetch(key: string): Promise<{ accessToken: string; expiresAt: string }>;
  /** Maps a fetch failure into the unified vocabulary (never marks). */
  classifyFetchError(err: unknown): ActionError | Promise<ActionError>;
}

/** An app-level token source, keyed by tenant: cache + early-refresh + single-flight. */
export interface CachedTokenProvider {
  getValid(key: string): Promise<string>;
}

/**
 * The app-level token cell (ADR-0015): the same early-refresh and
 * single-flight discipline as the user-token cell, but cache-only — app
 * tokens live in memory per tenant and are re-fetched when they approach
 * expiry. A rejection here is an operator-credential problem, never a dead
 * user grant, so nothing is ever marked: the classifier decides the error,
 * the cell only schedules the fetch.
 */
export function createCachedTokenProvider(
  profile: AppTokenProfile,
  deps: { refreshWindowMs?: number; now?: () => number } = {},
): CachedTokenProvider {
  const cache = new Map<string, { token: string; expiresAt: number }>();
  const fetches = new Map<string, Promise<string>>();
  const now = deps.now ?? Date.now;
  const refreshWindowMs = deps.refreshWindowMs ?? DEFAULT_REFRESH_WINDOW_MS;

  async function getValid(key: string): Promise<string> {
    const cached = cache.get(key);
    if (cached && cached.expiresAt - now() > refreshWindowMs) {
      return cached.token;
    }
    const inflight = fetches.get(key);
    if (inflight) return inflight;
    const pending = fetchToken(key).finally(() => {
      fetches.delete(key);
    });
    fetches.set(key, pending);
    return pending;
  }

  async function fetchToken(key: string): Promise<string> {
    try {
      const pair = await profile.fetch(key);
      cache.set(key, { token: pair.accessToken, expiresAt: Date.parse(pair.expiresAt) });
      return pair.accessToken;
    } catch (err) {
      throw await profile.classifyFetchError(err);
    }
  }

  return { getValid };
}
