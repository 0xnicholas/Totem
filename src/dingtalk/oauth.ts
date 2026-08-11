import type { DingTalkAppCredentials } from './creds-store.js';

/**
 * A token pair as issued by the DingTalk userAccessToken endpoint.
 * `expiresAt` is the access-token expiry computed from `expireIn` at issue
 * time. DingTalk may omit the refresh token on refresh responses (no
 * rotation); the client keeps the previous one in that case.
 */
export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  /** ISO timestamp when the access token expires. */
  expiresAt: string;
  /** ISO timestamp when the refresh token expires (diagnostics). */
  refreshTokenExpiresAt: string;
}

/**
 * A DingTalk Open Platform API failure, thrown by the OAuth client.
 * `invalidGrant` marks token-endpoint rejections (bad/revoked codes or
 * refresh tokens, bad client credentials): the grant cannot be used again,
 * which is the raw material of ADR-0005's `auth_expired`.
 */
export class DingTalkApiError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  readonly invalidGrant: boolean;

  constructor(code: string, message: string, httpStatus: number, invalidGrant: boolean) {
    super(message);
    this.name = 'DingTalkApiError';
    this.code = code;
    this.httpStatus = httpStatus;
    this.invalidGrant = invalidGrant;
  }
}

/** The token flow endpoints of the DingTalk Open Platform (OAuth 2.0). */
export interface DingTalkOAuthClient {
  /** The authorization URL the user's browser is sent to (login.dingtalk.com). */
  buildAuthorizationUrl(opts: { appKey: string; redirectUri: string; state: string }): string;
  /**
   * Exchanges the authorization code from the callback for a token pair.
   * DingTalk binds the code to the client id, so no redirect_uri is sent
   * on the token call.
   */
  exchangeCode(opts: { creds: DingTalkAppCredentials; code: string }): Promise<TokenPair>;
  /** Refreshes an access token with its refresh token. */
  refreshToken(opts: { creds: DingTalkAppCredentials; refreshToken: string }): Promise<TokenPair>;
  /**
   * The app-level access token (client credentials, `POST
   * /v1.0/oauth2/accessToken`). Live-confirmed (T17 live pass): the doc,
   * wiki and storage APIs authenticate with the APP token plus the acting
   * user's `operatorId` — the user access token only serves the identity
   * APIs (`users/me`). `expiresAt` is computed from `expireIn`.
   */
  appAccessToken(opts: { creds: DingTalkAppCredentials }): Promise<{ accessToken: string; expiresAt: string }>;
}

const AUTHORIZE_PATH = '/oauth2/auth';
const USER_ACCESS_TOKEN_PATH = '/v1.0/oauth2/userAccessToken';
const APP_ACCESS_TOKEN_PATH = '/v1.0/oauth2/accessToken';

/**
 * The scope the authorize request declares. DingTalk's OAuth 2.0 user
 * authorization has a single practical scope — `openid` — which grants the
 * user-access-token and the identity APIs (`users/me`) that
 * `test_connection` uses. Doc/wiki API permissions are NOT granted via
 * OAuth scope in DingTalk: they are per-app API permissions enabled in the
 * DingTalk developer console and are checked server-side per call.
 *
 * Live-confirmed (T17 live pass): the doc actions authenticate with the
 * APP-level token (client credentials, `appAccessToken`) plus the acting
 * user's `operatorId`; the `openid` user token serves only the identity
 * APIs. The console-granted permission points the app needs are
 * `Storage.File.Write`/`Storage.File.Read` families, `Wiki.*` and
 * `Document.*` per API — recorded in the connector's live-shape notes.
 */
const DEFAULT_AUTHORIZE_SCOPES = 'openid';

/**
 * HTTP client for the DingTalk OAuth endpoints. The base URLs are
 * injectable so tests run against the Seam B mock server; production uses
 * `DINGTALK_AUTHORIZE_BASE_URL` (default `https://login.dingtalk.com`) for
 * the browser redirect and `DINGTALK_API_BASE_URL` (default
 * `https://api.dingtalk.com`) for the API calls. Errors are classified for
 * the TokenManager:
 *
 * - token-endpoint rejection (HTTP 400/401 with a `{code, message}` body)
 *   → `invalidGrant`;
 * - HTTP 429 → rate limited (surfaced via `httpStatus`);
 * - anything else (network, non-JSON responses) → generic failure.
 */
export interface DingTalkOAuthClientOptions {
  authorizeBaseUrl?: string;
  apiBaseUrl?: string;
  /** Authorize-time scope list (space-separated). Defaults to `openid`. */
  scopes?: string;
  now?: () => number;
}

export function createDingTalkOAuthClient(
  options: DingTalkOAuthClientOptions = {},
): DingTalkOAuthClient {
  const authorizeBaseUrl = options.authorizeBaseUrl ?? 'https://login.dingtalk.com';
  const apiBaseUrl = options.apiBaseUrl ?? 'https://api.dingtalk.com';
  const scopes = options.scopes ?? DEFAULT_AUTHORIZE_SCOPES;
  const now = options.now ?? Date.now;

  return {
    buildAuthorizationUrl({ appKey, redirectUri, state }) {
      const url = new URL(`${authorizeBaseUrl}${AUTHORIZE_PATH}`);
      url.searchParams.set('redirect_uri', redirectUri);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('client_id', appKey);
      url.searchParams.set('scope', scopes);
      url.searchParams.set('state', state);
      url.searchParams.set('prompt', 'consent');
      return url.toString();
    },

    async exchangeCode({ creds, code }) {
      return tokenRequest({
        apiBaseUrl,
        now,
        body: {
          clientId: creds.appKey,
          clientSecret: creds.appSecret,
          grantType: 'authorization_code',
          code,
        },
      });
    },

    async refreshToken({ creds, refreshToken }) {
      const pair = await tokenRequest({
        apiBaseUrl,
        now,
        body: {
          clientId: creds.appKey,
          clientSecret: creds.appSecret,
          grantType: 'refresh_token',
          refreshToken,
        },
      });
      // DingTalk may not rotate the refresh token on refresh; keep the
      // previous one so the stored pair always has a usable refresh token.
      if (pair.refreshToken === '') {
        return { ...pair, refreshToken };
      }
      return pair;
    },

    async appAccessToken({ creds }) {
      let response: Response;
      try {
        response = await fetch(`${apiBaseUrl}${APP_ACCESS_TOKEN_PATH}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ appKey: creds.appKey, appSecret: creds.appSecret }),
        });
      } catch (err) {
        throw new DingTalkApiError(
          'NetworkError',
          err instanceof Error
            ? `DingTalk app-token endpoint unreachable: ${err.message}`
            : String(err),
          0,
          false,
        );
      }

      let envelope: TokenEnvelope;
      try {
        envelope = (await response.json()) as TokenEnvelope;
      } catch {
        throw new DingTalkApiError(
          'InvalidResponse',
          `DingTalk app-token endpoint returned non-JSON (HTTP ${response.status})`,
          response.status,
          false,
        );
      }
      if (response.status === 429) {
        throw new DingTalkApiError(
          envelope.code ?? 'TooManyRequests',
          envelope.message ?? 'DingTalk rate limited',
          429,
          false,
        );
      }
      if (!response.ok || !envelope.accessToken) {
        // A rejected app-token request means the operator-configured app
        // credentials are wrong — not the connection's user grant, so this
        // is never `invalidGrant` (the connection must NOT be poisoned).
        throw new DingTalkApiError(
          envelope.code ?? 'InvalidClient',
          `DingTalk app-token endpoint error (HTTP ${response.status}): ${envelope.message ?? 'no accessToken'}`,
          response.status,
          false,
        );
      }
      return {
        accessToken: envelope.accessToken,
        expiresAt: new Date(now() + (envelope.expireIn ?? 0) * 1000).toISOString(),
      };
    },
  };
}

interface TokenEnvelope {
  accessToken?: string;
  refreshToken?: string;
  /** Seconds until the access token expires. */
  expireIn?: number;
  /** Seconds until the refresh token expires (diagnostics). */
  refreshTokenExpireIn?: number;
  // DingTalk error body: `{code, message}`.
  code?: string;
  message?: string;
}

async function tokenRequest(opts: {
  apiBaseUrl: string;
  now: () => number;
  body: Record<string, string>;
}): Promise<TokenPair> {
  let response: Response;
  try {
    response = await fetch(`${opts.apiBaseUrl}${USER_ACCESS_TOKEN_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(opts.body),
    });
  } catch (err) {
    // Network-level failure: nothing DingTalk told us, not an invalid grant.
    throw new DingTalkApiError(
      'NetworkError',
      err instanceof Error ? `DingTalk token endpoint unreachable: ${err.message}` : String(err),
      0,
      false,
    );
  }

  let envelope: TokenEnvelope;
  let rawBody = '';
  try {
    rawBody = await response.text();
    envelope = JSON.parse(rawBody) as TokenEnvelope;
  } catch {
    throw new DingTalkApiError(
      'InvalidResponse',
      `DingTalk token endpoint returned non-JSON (HTTP ${response.status}): ${rawBody.slice(0, 200)}`,
      response.status,
      false,
    );
  }

  if (response.status === 429) {
    throw new DingTalkApiError(
      envelope.code ?? 'TooManyRequests',
      envelope.message ?? 'DingTalk rate limited',
      429,
      false,
    );
  }
  if (!response.ok || !envelope.accessToken) {
    // A token endpoint that answers with an error (or without a token) has
    // rejected the grant: bad/expired code, revoked refresh token, or bad
    // client credentials. Per OAuth token-endpoint semantics the grant
    // cannot be used again — transient server-side trouble surfaces as 429
    // (mapped separately) or 5xx, and only 4xx rejections (other than 429)
    // mark the grant dead.
    const grantRejected = response.status >= 400 && response.status < 500;
    const reason =
      envelope.code && envelope.message
        ? `${envelope.code}: ${envelope.message}`
        : !envelope.accessToken
          ? 'the response contains no accessToken'
          : `HTTP ${response.status}`;
    throw new DingTalkApiError(
      envelope.code ?? 'InvalidGrant',
      `DingTalk token endpoint error (HTTP ${response.status}): ${reason} — raw: ${rawBody.slice(0, 600)}`,
      response.status,
      grantRejected,
    );
  }

  const nowMs = opts.now();
  return {
    accessToken: envelope.accessToken,
    // Empty marker: the caller keeps the previous refresh token.
    refreshToken: envelope.refreshToken ?? '',
    expiresAt: new Date(nowMs + (envelope.expireIn ?? 0) * 1000).toISOString(),
    refreshTokenExpiresAt: new Date(
      nowMs + (envelope.refreshTokenExpireIn ?? 0) * 1000,
    ).toISOString(),
  };
}
