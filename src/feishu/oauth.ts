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
 * HTTP client for the Feishu OAuth endpoints. The base URL is injectable so
 * tests run against the Seam B mock server; production uses
 * `FEISHU_BASE_URL` (default `https://open.feishu.cn`). Errors are
 * classified for the TokenManager:
 *
 * - token-endpoint envelope rejection (non-zero `code`) → `invalidGrant`;
 * - HTTP 429 → rate limited (surfaced via `httpStatus`);
 * - anything else (network, non-envelope responses) → generic failure.
 */
export function createFeishuOAuthClient(
  baseUrl: string,
  now: () => number = Date.now,
): FeishuOAuthClient {
  return {
    buildAuthorizationUrl({ appId, redirectUri, state }) {
      const url = new URL(`${baseUrl}${AUTHORIZE_PATH}`);
      url.searchParams.set('app_id', appId);
      url.searchParams.set('redirect_uri', redirectUri);
      url.searchParams.set('state', state);
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
  code: number;
  msg?: string;
  data?: {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    refresh_token_expires_in?: number;
  };
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
  try {
    envelope = (await response.json()) as TokenEnvelope;
  } catch {
    throw new FeishuApiError(0, `Feishu token endpoint returned non-JSON (HTTP ${response.status})`, response.status, false);
  }

  if (response.status === 429) {
    throw new FeishuApiError(envelope.code || 0, envelope.msg ?? 'Feishu rate limited', 429, false);
  }
  if (envelope.code !== 0 || !envelope.data?.access_token || !envelope.data.refresh_token) {
    // A token endpoint that answers with an error envelope has rejected the
    // grant: bad/expired code, revoked refresh token, or bad client creds.
    // Per OAuth token-endpoint semantics, an envelope rejection means the
    // grant cannot be used again — transient server-side trouble surfaces
    // as 429 (mapped separately) or 5xx, not as an envelope error.
    throw new FeishuApiError(
      envelope.code ?? 0,
      envelope.msg ?? `Feishu token endpoint error (HTTP ${response.status})`,
      response.status,
      true,
    );
  }

  const nowMs = opts.now();
  return {
    accessToken: envelope.data.access_token,
    refreshToken: envelope.data.refresh_token,
    expiresAt: new Date(nowMs + (envelope.data.expires_in ?? 0) * 1000).toISOString(),
    refreshTokenExpiresAt: new Date(
      nowMs + (envelope.data.refresh_token_expires_in ?? 0) * 1000,
    ).toISOString(),
  };
}
