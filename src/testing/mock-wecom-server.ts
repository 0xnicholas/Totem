import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { randomUUID } from 'node:crypto';

interface ScriptedFailure {
  errcode?: number;
  httpStatus?: ContentfulStatusCode;
  message: string;
}

export interface MockWeComServerOptions {
  corpId: string;
  secret: string;
  /** Access token lifetime issued to clients, in seconds (WeCom's documented default: 7200). */
  accessTokenTtlSeconds?: number;
}

/**
 * Seam B (#48, ADR-0017): an in-memory mock of the WeCom (企业微信)
 * self-built-app API surface the platform talks to before the messaging
 * connector lands (#47) — currently the gettoken endpoint that backs the
 * cached token cell.
 *
 * WeCom's envelope convention (tracked by the kernel's WeCom profile):
 * HTTP is (almost) always 200 and `errcode !== 0` is the failure signal —
 * unlike Feishu's `code`, the field is `errcode`/`errmsg`, and invalid
 * corpid/secret is a 40001 over HTTP 200. Business APIs authenticate with
 * `?access_token=` (query param), which the kernel profile models via
 * `tokenQueryName` (#48).
 */
export class MockWeComServer {
  readonly app: Hono;
  /** Number of gettoken calls received. */
  gettokenRequestCount = 0;

  private readonly accessTokenTtlSeconds: number;
  private readonly issuedAccessTokens = new Map<string, { expiresAt: number }>();
  private scriptedFailure: ScriptedFailure | undefined;

  constructor(private readonly options: MockWeComServerOptions) {
    this.accessTokenTtlSeconds = options.accessTokenTtlSeconds ?? 7200;
    this.app = new Hono();

    // GET /cgi-bin/gettoken — client credentials for self-built apps. The
    // credentials ARE the query params; the response is an errcode envelope.
    this.app.get('/cgi-bin/gettoken', (c) => {
      const scripted = this.scriptedFailure;
      if (scripted) {
        this.scriptedFailure = undefined;
        const body: Record<string, unknown> = { errmsg: scripted.message };
        if (scripted.errcode !== undefined) body.errcode = scripted.errcode;
        return c.json(body, scripted.httpStatus ?? 200);
      }
      this.gettokenRequestCount++;
      const corpid = c.req.query('corpid');
      const corpsecret = c.req.query('corpsecret');
      if (corpid !== options.corpId || corpsecret !== options.secret) {
        // WeCom convention: HTTP 200 + errcode 40001 (invalid credentials).
        return c.json({ errcode: 40001, errmsg: 'invalid corpid or corpsecret' }, 200);
      }
      const accessToken = `wc_access_${randomUUID()}`;
      this.issuedAccessTokens.set(accessToken, {
        expiresAt: Date.now() + this.accessTokenTtlSeconds * 1000,
      });
      return c.json({
        errcode: 0,
        errmsg: 'ok',
        access_token: accessToken,
        expires_in: this.accessTokenTtlSeconds,
      });
    });
  }

  /** True when the presented token is one this mock issued and it is unexpired. */
  isTokenValid(token: string | undefined): boolean {
    const record = token ? this.issuedAccessTokens.get(token) : undefined;
    return record !== undefined && Date.now() <= record.expiresAt;
  }

  /** Scripts one failure for the next gettoken call. */
  failNext(failure: ScriptedFailure): void {
    this.scriptedFailure = failure;
  }
}
