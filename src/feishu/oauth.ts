import type { FeishuAppCredentials } from './creds-store.js';

/**
 * A token pair as issued by the Feishu token endpoint. `expiresAt` is the
 * access-token expiry computed from `expires_in` at issue time.
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
 * A Feishu Open Platform API failure, thrown by the OAuth client.
 * `invalidGrant` marks token-endpoint rejections (bad/revoked codes or
 * refresh tokens, bad client credentials): the grant cannot be used again,
 * which is the raw material of ADR-0005's `auth_expired`.
 */
export class FeishuApiError extends Error {
  readonly code: number;
  readonly httpStatus: number;
  readonly invalidGrant: boolean;

  constructor(code: number, message: string, httpStatus: number, invalidGrant: boolean) {
    super(message);
    this.name = 'FeishuApiError';
    this.code = code;
    this.httpStatus = httpStatus;
    this.invalidGrant = invalidGrant;
  }
}

/** The token flow endpoints of the Feishu Open Platform. */
export interface FeishuOAuthClient {
  /** The authorization URL the user's browser is sent to. */
  buildAuthorizationUrl(opts: { appId: string; redirectUri: string; state: string }): string;
  /** Exchanges the authorization code from the callback for a token pair. */
  exchangeCode(opts: {
    creds: FeishuAppCredentials;
    code: string;
    redirectUri: string;
  }): Promise<TokenPair>;
  /** Refreshes an access token with its refresh token. */
  refreshToken(opts: { creds: FeishuAppCredentials; refreshToken: string }): Promise<TokenPair>;
}

const AUTHORIZE_PATH = '/open-apis/authen/v1/authorize';
const TOKEN_PATH = '/open-apis/authen/v2/oauth/token';

/**
 * Scopes the authorize request declares. Feishu's scope parameter DEFINES
 * what the user grants (live-verified in the T9 demo pass): requesting only
 * `offline_access` yields a token without any business scope, so every
 * docx/drive/sheets/bitable call fails with 99991679. The platform's token
 * refresh design (ADR-0004) requires refresh tokens → `offline_access` is
 * mandatory; the rest covers the v1 action set plus messaging (im:message,
 * ADR-0016). Each scope must also be
 * enabled on the app in the Feishu console, or the authorize page rejects.
 */
const DEFAULT_AUTHORIZE_SCOPES = [
  'offline_access',
  'docx:document:readonly',
  'docx:document:create',
  'docx:document',
  'drive:drive:readonly',
  'drive:drive',
  'drive:export:readonly',
  'sheets:spreadsheet:readonly',
  'sheets:spreadsheet',
  'bitable:app:readonly',
  'bitable:app',
  // Messaging (ADR-0016): send_message as the connection's owner. Existing
  // connections lack this scope until they re-run the Authorize Flow
  // (re-authorization is native to the flow).
  'im:message',
].join(' ');

/**
 * HTTP client for the Feishu OAuth endpoints. The base URL is injectable so
 * tests run against the Seam B mock server; production uses
 * `FEISHU_BASE_URL` (default `https://open.feishu.cn`). Errors are
 * classified for the TokenManager:
 *
 * - token-endpoint envelope rejection (non-zero `code`) → `invalidGrant`;
 * - HTTP 429 → rate limited (surfaced via `httpStatus`);
 * - anything else (network, non-envelope responses) → generic failure.
 */
export interface FeishuOAuthClientOptions {
  /** Authorize-time scope list (space-separated). Defaults to the v1 set. */
  scopes?: string;
  now?: () => number;
}

export function createFeishuOAuthClient(
  baseUrl: string,
  options: FeishuOAuthClientOptions = {},
): FeishuOAuthClient {
  const scopes = options.scopes ?? DEFAULT_AUTHORIZE_SCOPES;
  const now = options.now ?? Date.now;
  return {
    buildAuthorizationUrl({ appId, redirectUri, state }) {
      const url = new URL(`${baseUrl}${AUTHORIZE_PATH}`);
      url.searchParams.set('app_id', appId);
      url.searchParams.set('redirect_uri', redirectUri);
      url.searchParams.set('state', state);
      url.searchParams.set('scope', scopes);
      return url.toString();
    },

    async exchangeCode({ creds, code, redirectUri }) {
      return tokenRequest({
        baseUrl,
        now,
        body: {
          grant_type: 'authorization_code',
          client_id: creds.appId,
          client_secret: creds.appSecret,
          code,
          redirect_uri: redirectUri,
        },
      });
    },

    async refreshToken({ creds, refreshToken }) {
      return tokenRequest({
        baseUrl,
        now,
        body: {
          grant_type: 'refresh_token',
          client_id: creds.appId,
          client_secret: creds.appSecret,
          refresh_token: refreshToken,
        },
      });
    },
  };
}

interface TokenEnvelope {
  code?: number;
  msg?: string;
  /** OAuth-style error description (Feishu v2 token endpoint). */
  error_description?: string;
  data?: {
    token_type?: string;
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    refresh_token_expires_in?: number;
  };
  // Flat OAuth-style success fields — Feishu's v2 token endpoint returns
  // these at the top level, NOT wrapped in a {code, msg, data} envelope
  // (live-verified in the T9 demo pass; the old envelope shape is still
  // accepted for the mock and v1-style responses).
  token_type?: string;
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  refresh_token_expires_in?: number;
}

async function tokenRequest(opts: {
  baseUrl: string;
  now: () => number;
  body: Record<string, string>;
}): Promise<TokenPair> {
  let response: Response;
  try {
    response = await fetch(`${opts.baseUrl}${TOKEN_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(opts.body),
    });
  } catch (err) {
    // Network-level failure: nothing Feishu told us, not an invalid grant.
    throw new FeishuApiError(
      0,
      err instanceof Error ? `Feishu token endpoint unreachable: ${err.message}` : String(err),
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
    throw new FeishuApiError(
      0,
      `Feishu token endpoint returned non-JSON (HTTP ${response.status}): ${rawBody.slice(0, 200)}`,
      response.status,
      false,
    );
  }

  if (response.status === 429) {
    throw new FeishuApiError(
      envelope.code ?? 0,
      envelope.msg ?? envelope.error_description ?? 'Feishu rate limited',
      429,
      false,
    );
  }
  // Success payload: prefer the enveloped data, else the flat body itself
  // (Feishu v2 token endpoint returns token fields at the top level).
  const payload = envelope.data ?? envelope;
  const code = envelope.code ?? 0;
  if (code !== 0 || !payload.access_token || !payload.refresh_token) {
    // A token endpoint that answers with an error envelope has rejected the
    // grant: bad/expired code, revoked refresh token, or bad client creds.
    // Per OAuth token-endpoint semantics, an envelope rejection means the
    // grant cannot be used again — transient server-side trouble surfaces
    // as 429 (mapped separately) or 5xx, not as an envelope error.
    // Live notes (T9 demo pass): Feishu's v2 endpoint answers in
    // OAuth-style shape (error/error_description, no msg); and an app with
    // only the base auth scope is issued an access_token but NO
    // refresh_token, so the missing-token case gets a config hint.
    const reason =
      code !== 0
        ? (envelope.msg ?? envelope.error_description ?? 'no error message')
        : !payload.access_token
          ? 'the response contains no access_token'
          : 'the response contains no refresh_token — the app is likely missing the permission scopes that grant refresh tokens; enable the business scopes and re-authorize';
    throw new FeishuApiError(
      code,
      `Feishu token endpoint error (code ${code}, HTTP ${response.status}): ${reason} — raw: ${rawBody.slice(0, 600)}`,
      response.status,
      true,
    );
  }

  const nowMs = opts.now();
  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token,
    expiresAt: new Date(nowMs + (payload.expires_in ?? 0) * 1000).toISOString(),
    refreshTokenExpiresAt: new Date(
      nowMs + (payload.refresh_token_expires_in ?? 0) * 1000,
    ).toISOString(),
  };
}
