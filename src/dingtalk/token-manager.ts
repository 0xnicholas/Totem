import { ActionError, errorMessage } from '../errors.js';
import { decryptValue, encryptValue } from '../feishu/crypto.js';
import type { DingTalkCredsStore } from './creds-store.js';
import { DingTalkApiError, type DingTalkOAuthClient } from './oauth.js';
import type { StoredTokens, TokenStore } from '../feishu/token-store.js';
import type { ConnectionStateStore, TokenProvider } from '../feishu/token-manager.js';

/** Refresh when the remaining validity drops below this (ADR-0004: early refresh). */
const DEFAULT_REFRESH_WINDOW_MS = 5 * 60 * 1000;

/**
 * The ADR-0004 deep module for DingTalk: the entire OAuth token lifecycle
 * behind `getValidAccessToken` —
 *
 * - encrypted read from the token store (per-tenant derived key);
 * - **early refresh** when remaining validity < 5 minutes, so a token
 *   never dies mid-call;
 * - **single-flight refresh**: concurrent calls for one connection share a
 *   single in-flight refresh promise — exactly one refresh hits DingTalk;
 * - **atomic write-back** of the refreshed pair (one upsert statement);
 * - **failure marking**: a revoked/invalid refresh token or missing tenant
 *   credentials surface as `auth_expired` (ADR-0005) and the connection is
 *   marked `auth_expired`; later calls fail fast with the stored state.
 *
 * A deliberate mirror of the Feishu TokenManager with DingTalk's client
 * and error types; the two generalize into one shared module when a third
 * connector lands (T17 spec decision: parallel shapes until then).
 *
 * Connectors never see any of this: they receive an already-valid token in
 * `ActionContext.token`.
 */
export class DingTalkTokenManager implements TokenProvider {
  private readonly refreshes = new Map<string, Promise<string>>();
  private readonly refreshWindowMs: number;
  private readonly now: () => number;

  constructor(
    private readonly deps: {
      tokenStore: TokenStore;
      credsStore: DingTalkCredsStore;
      oauth: DingTalkOAuthClient;
      connectionState: ConnectionStateStore;
      masterKey: string;
      now?: () => number;
      refreshWindowMs?: number;
    },
  ) {
    this.now = deps.now ?? Date.now;
    this.refreshWindowMs = deps.refreshWindowMs ?? DEFAULT_REFRESH_WINDOW_MS;
  }

  async getValidAccessToken(connectionId: string): Promise<string> {
    // Fail fast once a dead grant has marked the connection (ADR-0004):
    // no point touching the token store or DingTalk until re-authorization.
    if ((await this.deps.connectionState.getStatus(connectionId)) === 'auth_expired') {
      throw new ActionError(
        'auth_expired',
        `Connection "${connectionId}" needs re-authorization (refresh token rejected)`,
      );
    }

    const stored = await this.deps.tokenStore.get(connectionId);
    if (!stored) {
      throw new ActionError(
        'auth_expired',
        `Connection "${connectionId}" has no stored tokens; run the OAuth flow first`,
      );
    }

    let accessToken: string;
    try {
      accessToken = decryptValue(stored.tenantId, stored.accessTokenCiphertext, this.deps.masterKey);
    } catch (err) {
      throw new ActionError(
        'upstream_error',
        `Stored access token could not be decrypted: ${errorMessage(err)}`,
      );
    }
    if (new Date(stored.expiresAt).getTime() - this.now() > this.refreshWindowMs) {
      return accessToken;
    }
    return this.refresh(connectionId, stored);
  }

  /** Single-flight: one in-flight refresh promise per connection. */
  private refresh(connectionId: string, stored: StoredTokens): Promise<string> {
    const inflight = this.refreshes.get(connectionId);
    if (inflight) return inflight;
    const refresh = this.doRefresh(connectionId, stored).finally(() => {
      this.refreshes.delete(connectionId);
    });
    this.refreshes.set(connectionId, refresh);
    return refresh;
  }

  private async doRefresh(connectionId: string, stored: StoredTokens): Promise<string> {
    const creds = await this.deps.credsStore.get(stored.tenantId);
    if (!creds) {
      throw new ActionError(
        'auth_expired',
        `Tenant "${stored.tenantId}" has no DingTalk credentials configured; refresh impossible`,
      );
    }

    try {
      const refreshToken = decryptValue(
        stored.tenantId,
        stored.refreshTokenCiphertext,
        this.deps.masterKey,
      );
      const pair = await this.deps.oauth.refreshToken({ creds, refreshToken });
      await this.deps.tokenStore.upsert({
        tenantId: stored.tenantId,
        connectionId,
        accessTokenCiphertext: encryptValue(stored.tenantId, pair.accessToken, this.deps.masterKey),
        refreshTokenCiphertext: encryptValue(
          stored.tenantId,
          pair.refreshToken,
          this.deps.masterKey,
        ),
        expiresAt: pair.expiresAt,
      });
      return pair.accessToken;
    } catch (err) {
      if (err instanceof DingTalkApiError) {
        if (err.httpStatus === 429) {
          throw new ActionError('rate_limited', `DingTalk rate limited during refresh: ${err.message}`);
        }
        if (err.invalidGrant) {
          // The grant is dead: mark the connection so subsequent calls fail
          // fast and the operator knows re-auth is needed. Best effort — a
          // failed mark must not change the error the caller sees.
          await this.deps.connectionState.markAuthExpired(connectionId).catch((markErr: unknown) => {
            console.error(`markAuthExpired failed for connection ${connectionId}: ${errorMessage(markErr)}`);
          });
          throw new ActionError('auth_expired', `DingTalk rejected the refresh token: ${err.message}`);
        }
      }
      throw new ActionError('upstream_error', `DingTalk token refresh failed: ${errorMessage(err)}`);
    }
  }
}
