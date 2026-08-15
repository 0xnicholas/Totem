import { createUpstreamHttp, type UpstreamHttp, type UpstreamHttpProfile } from '../upstream-http.js';
import type { WeComAppCredentials } from './creds-store.js';

/**
 * A WeCom (企业微信) API failure, thrown from the WeCom kernel profile's
 * envelope check. WeCom's convention: HTTP is (almost) always 200 and
 * `errcode !== 0` is the failure signal — so the error carries WeCom's
 * numeric `errcode` (the HTTP status stands in when the envelope is
 * missing) plus the transport status.
 */
export class WeComApiError extends Error {
  readonly errcode: number;
  readonly httpStatus: number;

  constructor(errcode: number, message: string, httpStatus: number) {
    super(message);
    this.name = 'WeComApiError';
    this.errcode = errcode;
    this.httpStatus = httpStatus;
  }
}

/**
 * The WeCom token surface (ADR-0017): the ONLY token flow WeCom
 * self-built apps have — gettoken (corpid + secret → app access token).
 * The "OAuth" in the name is the family convention (feishu/oauth.ts,
 * dingtalk/oauth.ts carry the token-flow client per ADR-0015); WeCom has
 * no OAuth dance, no user tokens, no refresh — one client-credentials
 * call with no consent of any kind.
 */
export interface WeComOAuthClient {
  /** Fetches the app-level access token (corpid + secret → token, 7200s). */
  appAccessToken(opts: {
    creds: WeComAppCredentials;
  }): Promise<{ accessToken: string; expiresAt: string }>;
}

/**
 * The WeCom envelope check (item 5 of #48): success is `errcode === 0` (or
 * absent) over HTTP 2xx; anything else — a non-2xx status OR a non-zero
 * errcode — is a `WeComApiError`. Same shape as the Feishu profile's
 * `code !== 0` check, different field names and a lying-by-default status.
 */
function wecomHandleResponse(response: Response, body: unknown): unknown {
  const envelope = (body ?? {}) as { errcode?: unknown; errmsg?: unknown };
  const errcode = typeof envelope.errcode === 'number' ? envelope.errcode : undefined;
  if (!response.ok || (errcode !== undefined && errcode !== 0)) {
    throw new WeComApiError(
      errcode ?? response.status,
      typeof envelope.errmsg === 'string' && envelope.errmsg !== ''
        ? envelope.errmsg
        : `WeCom API error (HTTP ${response.status})`,
      response.status,
    );
  }
  return envelope;
}

/**
 * The WeCom family's Upstream HTTP Kernel callable (#48): one profile, two
 * consumers — the OAuth client (gettoken carries corpid+corpsecret as
 * query params, no auth) and the #47 messaging connector (business calls
 * authenticate with `?access_token=`, hence `tokenQueryName`).
 */
export function createWeComHttp(apiBaseUrl: string, fetchImpl?: typeof fetch): UpstreamHttp {
  const profile: UpstreamHttpProfile = {
    baseUrl: apiBaseUrl,
    label: 'WeCom API',
    // No authHeaderName: WeCom never authenticates by header — gettoken is
    // pre-auth (credentials in the query), business calls use the query
    // token below.
    tokenQueryName: 'access_token',
    allowEmptyBody: false,
    handleResponse: wecomHandleResponse,
    ...(fetchImpl !== undefined ? { fetchImpl } : {}),
  };
  return createUpstreamHttp(profile);
}

const GETTOKEN_PATH = '/cgi-bin/gettoken';

/** WeCom's documented access-token TTL when the response omits expires_in. */
const DEFAULT_EXPIRES_IN_SECONDS = 7200;

/**
 * HTTP client for the WeCom token endpoint. The base URL is injectable so
 * tests run against the Seam B mock server; production uses
 * `WECOM_API_BASE_URL` (default `https://qyapi.weixin.qq.com`). ADR-0017:
 * this is the ONLY token flow WeCom has — corpid + secret in, app access
 * token out; there is no refresh and no user grant to lose, so failures
 * are operator-credential problems, never `auth_expired`.
 */
export function createWeComOAuthClient(options: {
  apiBaseUrl: string;
  now?: () => number;
}): WeComOAuthClient {
  const now = options.now ?? Date.now;
  const request = createWeComHttp(options.apiBaseUrl);
  return {
    async appAccessToken({ creds }) {
      const body = await request<{
        access_token?: string;
        expires_in?: number;
      }>(GETTOKEN_PATH, {
        query: { corpid: creds.corpId, corpsecret: creds.secret },
      });
      const accessToken = body.access_token;
      if (typeof accessToken !== 'string' || accessToken === '') {
        throw new WeComApiError(
          -1,
          'WeCom gettoken response omitted access_token despite errcode 0',
          200,
        );
      }
      const ttl = typeof body.expires_in === 'number' ? body.expires_in : DEFAULT_EXPIRES_IN_SECONDS;
      return { accessToken, expiresAt: new Date(now() + ttl * 1000).toISOString() };
    },
  };
}
