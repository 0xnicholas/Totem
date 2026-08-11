import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Context } from 'hono';
import { randomUUID } from 'node:crypto';
import { isRecord } from '../admin/util.js';

/** DingTalk v1.0 API error shape: HTTP status + `{code, message}`. */
interface DingTalkErrorBody {
  code: string;
  message: string;
}

const INVALID_AUTH = { code: 'InvalidAuthentication', message: 'invalid access token' } satisfies DingTalkErrorBody;

interface ScriptedFailure {
  code: string;
  message: string;
  httpStatus?: ContentfulStatusCode;
}

export interface MockDingTalkServerOptions {
  appKey: string;
  appSecret: string;
  /** Access token lifetime issued to clients, in ms. */
  accessTokenTtlMs?: number;
  /** Refresh token lifetime issued to clients, in ms. */
  refreshTokenTtlMs?: number;
}

/** A seeded online document in the mock's DingTalk knowledge base (T17b). */
export interface MockDingTalkDoc {
  /** The document identity (the platform's opaque doc_id). */
  docKey: string;
  name: string;
  /** Markdown content — what the doc content API returns. */
  content: string;
  /** The owning user's unionId. */
  ownerUnionId: string;
  /** DingTalk's dentry content type; defaults to 'alidoc' (online doc). */
  contentType?: string;
  /** Epoch ms timestamps (DingTalk's Long shapes). */
  createdTime?: number;
  updatedTime?: number;
}

/**
 * Seam B (T17a): an in-memory mock of the DingTalk Open Platform surface
 * used by the connection tests — the OAuth 2.0 authorize redirect, the
 * userAccessToken endpoint (code exchange + refresh), and the
 * `users/me` identity call that `test_connection` uses as its live proof —
 * so no real DingTalk credentials are needed in CI.
 *
 * The mock mirrors DingTalk's shapes: form-free JSON token endpoint with
 * flat `{accessToken, refreshToken, expireIn}` success bodies and
 * `{code, message}` error bodies (HTTP 400 for bad grants, 429 for rate
 * limits), plus the `x-acs-dingtalk-access-token` header on v1.0 APIs. It
 * supports the token-lifecycle scenarios the tests need: revoking refresh
 * tokens and scripting failures for the next call.
 *
 * T17b adds the doc read surface: `POST /v2.0/storage/dentries/search`
 * (keyword search over seeded online docs, `operatorId` required), and the
 * doc family `GET /v1.0/doc/suites/documents/{docKey}` (+ `/content`) —
 * shapes modeled on the published API docs; the live pass (AC-7) corrects
 * any drift.
 */
export class MockDingTalkServer {
  readonly app: Hono;
  /** Number of refresh_token grant calls received. */
  refreshRequestCount = 0;
  /** Number of authorization_code grant calls received. */
  exchangeRequestCount = 0;

  private readonly accessTokenTtlMs: number;
  private readonly refreshTokenTtlMs: number;
  private readonly issuedCodes = new Set<string>();
  private readonly refreshTokens = new Map<string, { active: boolean }>();
  private readonly issuedAccessTokens = new Map<string, { expiresAt: number }>();
  private scriptedFailure: ScriptedFailure | undefined;
  private omitRefreshTokenArmed = false;
  private readonly docs: MockDingTalkDoc[] = [];

  constructor(private readonly options: MockDingTalkServerOptions) {
    this.accessTokenTtlMs = options.accessTokenTtlMs ?? 2 * 60 * 60 * 1000;
    this.refreshTokenTtlMs = options.refreshTokenTtlMs ?? 30 * 24 * 60 * 60 * 1000;
    this.app = new Hono();

    // The authorize page: validates app key + redirect, issues a code, and
    // redirects the user's browser back with code + state (DingTalk OAuth 2.0).
    this.app.get('/oauth2/auth', (c) => {
      const clientId = c.req.query('client_id');
      const redirectUri = c.req.query('redirect_uri');
      const state = c.req.query('state');
      const responseType = c.req.query('response_type');
      if (!clientId || !redirectUri || responseType !== 'code') {
        return c.json({ code: 'InvalidParameter', message: 'missing client_id, redirect_uri or response_type' }, 400);
      }
      if (clientId !== options.appKey) {
        return c.json({ code: 'InvalidClient', message: 'unknown client_id' }, 400);
      }
      const code = randomUUID();
      this.issuedCodes.add(code);
      const location = new URL(redirectUri);
      location.searchParams.set('code', code);
      location.searchParams.set('state', state ?? '');
      return c.redirect(location.toString(), 302);
    });

    // POST /v1.0/oauth2/userAccessToken — JSON body, flat token response.
    this.app.post('/v1.0/oauth2/userAccessToken', async (c) => {
      const body = await readJson(c);
      if (!isRecord(body)) {
        return c.json({ code: 'InvalidParameter', message: 'expected a JSON body' }, 400);
      }
      const clientId = typeof body.clientId === 'string' ? body.clientId : undefined;
      const clientSecret = typeof body.clientSecret === 'string' ? body.clientSecret : undefined;
      if (clientId !== options.appKey || clientSecret !== options.appSecret) {
        return c.json({ code: 'InvalidClient', message: 'invalid client credentials' }, 400);
      }
      const grantType = body.grantType;

      if (grantType === 'authorization_code') {
        this.exchangeRequestCount++;
        const code = typeof body.code === 'string' ? body.code : undefined;
        if (!code || !this.issuedCodes.delete(code)) {
          return c.json({ code: 'InvalidAuthentication', message: 'invalid authorization code' }, 400);
        }
        return c.json(this.tokenBody());
      }

      if (grantType === 'refresh_token') {
        this.refreshRequestCount++;
        const scripted = this.scriptedResponse();
        if (scripted) return scripted;
        const refreshToken = typeof body.refreshToken === 'string' ? body.refreshToken : undefined;
        const record = refreshToken ? this.refreshTokens.get(refreshToken) : undefined;
        if (!record?.active) {
          return c.json({ code: 'InvalidAuthentication', message: 'invalid refresh token' }, 400);
        }
        return c.json(this.tokenBody());
      }

      return c.json({ code: 'InvalidParameter', message: `unsupported grantType "${String(grantType)}"` }, 400);
    });

    // GET /v1.0/contact/users/me — the identity call test_connection uses.
    this.app.get('/v1.0/contact/users/me', (c) => {
      const scripted = this.scriptedResponse();
      if (scripted) return scripted;
      const token = c.req.header('x-acs-dingtalk-access-token');
      const record = token ? this.issuedAccessTokens.get(token) : undefined;
      if (!record) {
        return c.json(INVALID_AUTH, 401);
      }
      if (Date.now() > record.expiresAt) {
        return c.json(INVALID_AUTH, 401);
      }
      return c.json({
        nick: 'Mock DingTalk User',
        unionId: 'mock-union-id',
        openId: 'mock-open-id',
        avatarUrl: 'https://mock.dingtalk.example/avatar.png',
      });
    });

    // POST /v2.0/storage/dentries/search — keyword search over the seeded
    // docs (v1 read scope: online docs only, category ALIDOC). Requires
    // the operatorId of the acting user, mirroring the real API.
    this.app.post('/v2.0/storage/dentries/search', async (c) => {
      const scripted = this.scriptedResponse();
      if (scripted) return scripted;
      const token = c.req.header('x-acs-dingtalk-access-token');
      if (!this.isAuthorized(token)) {
        return c.json(INVALID_AUTH, 401);
      }
      if (!c.req.query('operatorId')) {
        return c.json({ code: 'paramError', message: 'missing operatorId' }, 400);
      }
      const body = await readJson(c);
      if (!isRecord(body) || typeof body.keyword !== 'string') {
        return c.json({ code: 'paramError', message: 'missing keyword' }, 400);
      }
      const keyword = body.keyword.toLowerCase();
      const maxResults =
        isRecord(body.option) && typeof body.option.maxResults === 'number'
          ? body.option.maxResults
          : 50;
      const matches = this.docs
        .filter((doc) => doc.name.toLowerCase().includes(keyword))
        .slice(0, maxResults);
      return c.json({
        dentries: matches.map((doc) => this.dentryShape(doc)),
        nextToken: '',
      });
    });

    // GET /v1.0/doc/suites/documents/{docKey} — document info.
    this.app.get('/v1.0/doc/suites/documents/:docKey', (c) => {
      const scripted = this.scriptedResponse();
      if (scripted) return scripted;
      const token = c.req.header('x-acs-dingtalk-access-token');
      if (!this.isAuthorized(token)) {
        return c.json(INVALID_AUTH, 401);
      }
      if (!c.req.query('operatorId')) {
        return c.json({ code: 'paramError', message: 'missing operatorId' }, 400);
      }
      const doc = this.docs.find((candidate) => candidate.docKey === c.req.param('docKey'));
      if (!doc) {
        return c.json({ code: 'DocumentNotFound', message: 'document not found' }, 404);
      }
      return c.json(this.dentryShape(doc));
    });

    // GET /v1.0/doc/suites/documents/{docKey}/content — markdown content.
    this.app.get('/v1.0/doc/suites/documents/:docKey/content', (c) => {
      const scripted = this.scriptedResponse();
      if (scripted) return scripted;
      const token = c.req.header('x-acs-dingtalk-access-token');
      if (!this.isAuthorized(token)) {
        return c.json(INVALID_AUTH, 401);
      }
      if (!c.req.query('operatorId')) {
        return c.json({ code: 'paramError', message: 'missing operatorId' }, 400);
      }
      const doc = this.docs.find((candidate) => candidate.docKey === c.req.param('docKey'));
      if (!doc) {
        return c.json({ code: 'DocumentNotFound', message: 'document not found' }, 404);
      }
      return c.json({ content: doc.content });
    });
  }

  /** True when the presented token is one this mock issued and it is unexpired. */
  private isAuthorized(token: string | undefined): boolean {
    const record = token ? this.issuedAccessTokens.get(token) : undefined;
    return record !== undefined && Date.now() <= record.expiresAt;
  }

  /** Consumes the scripted failure, if any, into a mock error response. */
  private scriptedResponse(): Response | undefined {
    const scripted = this.scriptedFailure;
    if (!scripted) return undefined;
    this.scriptedFailure = undefined;
    return new Response(JSON.stringify({ code: scripted.code, message: scripted.message }), {
      status: scripted.httpStatus ?? 400,
      headers: { 'content-type': 'application/json' },
    });
  }

  /** The dentry response shape shared by search + doc info. */
  private dentryShape(doc: MockDingTalkDoc): {
    dentryId: string;
    docKey: string;
    name: string;
    contentType: string;
    url: string;
    createdTime: number;
    updatedTime: number;
    creator: { unionId: string; name: string };
  } {
    return {
      dentryId: `dentry-${doc.docKey}`,
      docKey: doc.docKey,
      name: doc.name,
      contentType: doc.contentType ?? 'alidoc',
      url: `https://alidocs.dingtalk.com/i/doc/${doc.docKey}`,
      createdTime: doc.createdTime ?? 1_700_000_000_000,
      updatedTime: doc.updatedTime ?? 1_700_000_000_000,
      creator: { unionId: doc.ownerUnionId, name: 'Mock Owner' },
    };
  }

  /** Seeds the mock's knowledge base with online documents (T17b). */
  seedDocs(docs: MockDingTalkDoc[]): void {
    this.docs.push(...docs);
  }

  /** A fresh token pair, issued against the configured TTLs. */
  private tokenBody(): {
    accessToken: string;
    refreshToken?: string;
    expireIn: number;
    refreshTokenExpireIn: number;
  } {
    const accessToken = `dt_access_${randomUUID()}`;
    const refreshToken = `dt_refresh_${randomUUID()}`;
    this.issuedAccessTokens.set(accessToken, {
      expiresAt: Date.now() + this.accessTokenTtlMs,
    });
    this.refreshTokens.set(refreshToken, { active: true });
    const omitRefresh = this.omitRefreshTokenArmed;
    this.omitRefreshTokenArmed = false;
    return {
      accessToken,
      // DingTalk may omit the refresh token on refresh responses (no
      // rotation): the client keeps the previous one in that case.
      ...(omitRefresh ? {} : { refreshToken }),
      expireIn: Math.floor(this.accessTokenTtlMs / 1000),
      refreshTokenExpireIn: Math.floor(this.refreshTokenTtlMs / 1000),
    };
  }

  /**
   * Walks the authorize redirect and returns the code issued for
   * `redirectUri` — a test convenience mirroring a user authorizing.
   */
  async authorizeCode(redirectUri: string, state: string): Promise<string> {
    const res = await this.app.fetch(
      new Request(
        `http://mock/oauth2/auth?client_id=${this.options.appKey}` +
          `&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code` +
          `&scope=openid&state=${encodeURIComponent(state)}&prompt=consent`,
        { redirect: 'manual' },
      ),
    );
    const redirect = res.headers.get('location');
    if (!redirect) throw new Error('mock authorize did not redirect');
    return new URL(redirect).searchParams.get('code')!;
  }

  /** Revokes a refresh token so later refresh attempts fail. */
  revokeRefreshToken(refreshToken: string): void {
    this.refreshTokens.get(refreshToken)!.active = false;
  }

  /** Scripts one failure for the next refresh_token or users/me call. */
  failNext(failure: ScriptedFailure): void {
    this.scriptedFailure = failure;
  }

  /** Next token response omits the refresh token (no-rotation simulation). */
  omitRefreshTokenNext(): void {
    this.omitRefreshTokenArmed = true;
  }
}

async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return undefined;
  }
}
