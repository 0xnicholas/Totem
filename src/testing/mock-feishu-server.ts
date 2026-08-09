import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Context } from 'hono';
import { randomUUID } from 'node:crypto';
import { isRecord } from '../admin/util.js';

const INVALID_TOKEN_ENVELOPE = { code: 99991672, msg: 'invalid access token' };

interface ScriptedFailure {
  code: number;
  msg: string;
  httpStatus?: ContentfulStatusCode;
}

export interface MockFeishuServerOptions {
  appId: string;
  appSecret: string;
  /** Access token lifetime issued to clients, in ms. */
  accessTokenTtlMs?: number;
  /** Refresh token lifetime issued to clients, in ms. */
  refreshTokenTtlMs?: number;
}

/** A document in the mock's Feishu drive (T7: docs endpoints). */
export interface MockFeishuDoc {
  doc_id: string;
  title: string;
  content: string;
  owner_id: string;
  doc_type: 'docx' | 'sheet' | 'bitable' | 'wiki';
  edited_at: string;
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
  private readonly issuedAccessTokens = new Set<string>();
  private readonly docs: MockFeishuDoc[] = [];
  private scriptedFailure: ScriptedFailure | undefined;
  private scriptedDocsFailure: ScriptedFailure | undefined;

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

    this.docsEndpoints();
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
  failNextRefresh(failure: ScriptedFailure): void {
    this.scriptedFailure = failure;
  }

  /** Replaces the mock's drive contents (T7 docs endpoints). */
  seedDocs(docs: MockFeishuDoc[]): void {
    this.docs.length = 0;
    this.docs.push(...docs.map((doc) => ({ ...doc })));
  }

  /** Scripts one failure for the next docs endpoint call. */
  failNextDocs(failure: ScriptedFailure): void {
    this.scriptedDocsFailure = failure;
  }

  private docsEndpoints(): void {
    this.app.post('/open-apis/drive/v1/files/search', async (c) => {
      const gate = this.docsGate(c);
      if (gate) return gate;

      const body: unknown = await c.req.json().catch(() => ({}));
      const searchKey =
        isRecord(body) && typeof body.search_key === 'string' ? body.search_key : '';
      const pageSize = Number(c.req.query('page_size') ?? 50) || 50;
      const needle = searchKey.toLowerCase();
      const files = this.docs
        .filter((doc) => doc.title.toLowerCase().includes(needle))
        .sort((a, b) => b.edited_at.localeCompare(a.edited_at))
        .slice(0, pageSize)
        .map((doc) => ({
          token: doc.doc_id,
          name: doc.title,
          type: doc.doc_type,
          url: `https://fake.feishu.local/docx/${doc.doc_id}`,
          modified_time: doc.edited_at,
          owner_id: doc.owner_id,
        }));
      return c.json({ code: 0, msg: 'ok', data: { files } });
    });

    this.app.get('/open-apis/docx/v1/documents/:docId/raw_content', (c) => {
      const gate = this.docsGate(c);
      if (gate) return gate;

      const doc = this.docs.find((d) => d.doc_id === c.req.param('docId'));
      if (!doc) return c.json({ code: 10662, msg: 'document not found' });
      return c.json({ code: 0, msg: 'ok', data: { content: doc.content } });
    });

    this.app.post('/open-apis/drive/v1/metas/batch_query', async (c) => {
      const gate = this.docsGate(c);
      if (gate) return gate;

      const body: unknown = await c.req.json().catch(() => ({}));
      const requestDocs =
        isRecord(body) && Array.isArray(body.request_docs) ? body.request_docs : [];
      const metas = [];
      for (const request of requestDocs) {
        if (!isRecord(request) || typeof request.doc_token !== 'string') continue;
        const doc = this.docs.find((d) => d.doc_id === request.doc_token);
        if (!doc) return c.json({ code: 10662, msg: 'document not found' });
        // Fidelity: the requested doc_type must match the stored doc's type
        // (the v1 connector asks for docx; anything else fails like the
        // live API would).
        if (isRecord(request) && typeof request.doc_type === 'string' && request.doc_type !== doc.doc_type) {
          return c.json({ code: 10662, msg: 'document not found' });
        }
        metas.push({
          doc_token: doc.doc_id,
          doc_type: doc.doc_type,
          title: doc.title,
          owner_id: doc.owner_id,
          modified_time: doc.edited_at,
        });
      }
      return c.json({ code: 0, msg: 'ok', data: { metas } });
    });
  }

  private authorized(c: Context): boolean {
    const header = c.req.header('authorization');
    const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;
    return token !== undefined && this.issuedAccessTokens.has(token);
  }

  /**
   * Docs-endpoint prologue: rejects unauthenticated calls and consumes a
   * scripted failure. Returns a Response to send, or undefined to proceed.
   */
  private docsGate(c: Context): Response | undefined {
    if (!this.authorized(c)) return c.json(INVALID_TOKEN_ENVELOPE);
    const scripted = this.scriptedDocsFailure;
    this.scriptedDocsFailure = undefined;
    if (scripted) return c.json({ code: scripted.code, msg: scripted.msg }, scripted.httpStatus ?? 200);
    return undefined;
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
    this.issuedAccessTokens.add(accessToken);
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
