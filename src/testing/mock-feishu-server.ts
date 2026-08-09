import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { randomUUID } from 'node:crypto';

export interface MockFeishuServerOptions {
  appId: string;
  appSecret: string;
  /** Access token lifetime issued to clients, in ms. */
  accessTokenTtlMs?: number;
  /** Refresh token lifetime issued to clients, in ms. */
  refreshTokenTtlMs?: number;
}

/**
 * Seam B (T6): an in-memory mock of the Feishu Open Platform auth surface
 * used by the connector tests — the authorization page redirect and the
 * v2 token endpoint (code exchange + refresh) — so no real Feishu
 * credentials are needed in CI (ticket AC-5). T7-T9 action tests run
 * against this same server.
 *
 * The mock mirrors Feishu's envelope (`{ code, msg, data }`) and supports
 * the token-lifecycle scenarios the tests need: revoking refresh tokens
 * and scripting failures (including HTTP 429) for the next call.
 */
export class MockFeishuServer {
  readonly app: Hono;
  /** Number of refresh_token grant calls received. */
  refreshRequestCount = 0;
  /** Number of authorization_code grant calls received. */
  exchangeRequestCount = 0;

  private readonly accessTokenTtlMs: number;
  private readonly refreshTokenTtlMs: number;
  private readonly issuedCodes = new Set<string>();
  private readonly refreshTokens = new Map<string, { active: boolean }>();
  private scriptedFailure: { code: number; msg: string; httpStatus?: ContentfulStatusCode } | undefined;

  constructor(private readonly options: MockFeishuServerOptions) {
    this.accessTokenTtlMs = options.accessTokenTtlMs ?? 2 * 60 * 60 * 1000;
    this.refreshTokenTtlMs = options.refreshTokenTtlMs ?? 30 * 24 * 60 * 60 * 1000;
    this.app = new Hono();

    this.app.get('/open-apis/authen/v1/authorize', (c) => {
      const appId = c.req.query('app_id');
      const redirectUri = c.req.query('redirect_uri');
      const state = c.req.query('state');
      if (!appId || !redirectUri) {
        return c.json({ code: 10002, msg: 'missing app_id or redirect_uri' }, 400);
      }
      const code = randomUUID();
      this.issuedCodes.add(code);
      const location = new URL(redirectUri);
      location.searchParams.set('code', code);
      location.searchParams.set('state', state ?? '');
      return c.redirect(location.toString(), 302);
    });

    this.app.post('/open-apis/authen/v2/oauth/token', async (c) => {
      const body = await c.req.formData();
      const grantType = field(body, 'grant_type');
      const clientId = field(body, 'client_id');
      const clientSecret = field(body, 'client_secret');
      if (clientId !== options.appId || clientSecret !== options.appSecret) {
        return c.json({ code: 10001, msg: 'invalid client credentials' });
      }

      if (grantType === 'authorization_code') {
        this.exchangeRequestCount++;
        const code = field(body, 'code');
        if (!this.issuedCodes.delete(code)) {
          return c.json({ code: 10666, msg: 'invalid authorization code' });
        }
        return c.json(this.tokenEnvelope());
      }

      if (grantType === 'refresh_token') {
        this.refreshRequestCount++;
        const scripted = this.scriptedFailure;
        if (scripted) {
          this.scriptedFailure = undefined;
          return c.json({ code: scripted.code, msg: scripted.msg }, scripted.httpStatus ?? 200);
        }
        const refreshToken = field(body, 'refresh_token');
        const record = this.refreshTokens.get(refreshToken);
        if (!record?.active) {
          return c.json({ code: 10666, msg: 'invalid refresh token' });
        }
        return c.json(this.tokenEnvelope());
      }

      return c.json({ code: 10002, msg: `unsupported grant_type "${grantType}"` });
    });
  }

  /**
   * Walks the authorize redirect and returns the code issued for
   * `redirectUri` — a test convenience mirroring a user authorizing.
   */
  async authorizeCode(redirectUri: string, state: string): Promise<string> {
    const res = await this.app.fetch(
      new Request(
        `http://mock/open-apis/authen/v1/authorize?app_id=${this.options.appId}` +
          `&redirect_uri=${encodeURIComponent(redirectUri)}&state=${encodeURIComponent(state)}`,
        { redirect: 'manual' },
      ),
    );
    const redirect = res.headers.get('location');
    if (!redirect) throw new Error('mock authorize did not redirect');
    return new URL(redirect).searchParams.get('code')!;
  }

  /** Revokes a refresh token so later refresh attempts fail (10666). */
  revokeRefreshToken(refreshToken: string): void {
    this.refreshTokens.get(refreshToken)!.active = false;
  }

  /** Scripts one failure for the next refresh_token call. */
  failNextRefresh(failure: { code: number; msg: string; httpStatus?: ContentfulStatusCode }): void {
    this.scriptedFailure = failure;
  }

  private tokenEnvelope(): {
    code: number;
    msg: string;
    data: {
      access_token: string;
      refresh_token: string;
      expires_in: number;
      refresh_token_expires_in: number;
      token_type: string;
    };
  } {
    const accessToken = `mock_access_${randomUUID()}`;
    const refreshToken = `mock_refresh_${randomUUID()}`;
    this.refreshTokens.set(refreshToken, { active: true });
    return {
      code: 0,
      msg: 'ok',
      data: {
        access_token: accessToken,
        refresh_token: refreshToken,
        expires_in: Math.floor(this.accessTokenTtlMs / 1000),
        refresh_token_expires_in: Math.floor(this.refreshTokenTtlMs / 1000),
        token_type: 'Bearer',
      },
    };
  }
}

/** FormData field as a string, or '' when absent. */
function field(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
}
