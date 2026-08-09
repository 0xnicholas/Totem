import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Context } from 'hono';
import { randomUUID } from 'node:crypto';
import { isRecord } from '../admin/util.js';
import { parseRange, sliceValues, writeValues } from './range.js';
import type { CellValue } from '../actions.js';

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
  /** Set by the drive move endpoint (T8). */
  folder_id?: string;
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
  private readonly lockedDocs = new Set<string>();
  private readonly sheets = new Map<string, { sheetName: string; values: CellValue[][] }>();
  private readonly bitables = new Map<string, Array<{ name: string; tableId: string; records: Array<{ record_id: string; fields: Record<string, unknown> }> }>>();
  private readonly exports = new Map<string, { status: number; fileToken: string }>();
  private holdNextExportArmed = false;
  private failNextExportArmed = false;
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
    this.writeEndpoints();
    this.advancedEndpoints();
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

  /** Locks a document: write endpoints reject it with 10667 (doc locked). */
  lockDoc(docId: string): void {
    this.lockedDocs.add(docId);
  }

  unlockDoc(docId: string): void {
    this.lockedDocs.delete(docId);
  }

  /**
   * Seeds a spreadsheet (T9): a drive file plus a single named sheet of
   * values. `sheetName` is the tab name ranges can reference.
   */
  seedSheet(docId: string, title: string, sheetName: string, values: CellValue[][]): void {
    this.docs.push({
      doc_id: docId,
      title,
      content: '',
      owner_id: 'mock-owner',
      doc_type: 'sheet',
      edited_at: new Date().toISOString(),
    });
    this.sheets.set(docId, { sheetName, values: values.map((row) => [...row]) });
  }

  /**
   * Seeds a Bitable app (T9): a drive file plus tables with optional
   * records. Records use field-name-based values.
   */
  seedBitable(
    docId: string,
    title: string,
    tables: Array<{ name: string; records?: Array<{ record_id: string; fields: Record<string, unknown> }> }>,
  ): void {
    this.docs.push({
      doc_id: docId,
      title,
      content: '',
      owner_id: 'mock-owner',
      doc_type: 'bitable',
      edited_at: new Date().toISOString(),
    });
    this.bitables.set(
      docId,
      tables.map((table) => ({
        name: table.name,
        tableId: `tbl_${randomUUID()}`,
        records: [...(table.records ?? [])].map((record) => ({ ...record })),
      })),
    );
  }

  /**
   * Holds the next created export task in the running state (job_status 1):
   * its first poll reports running, later polls complete.
   */
  holdNextExport(): void {
    this.holdNextExportArmed = true;
  }

  /** Fails the next created export task (job_status 2). */
  failNextExport(): void {
    this.failNextExportArmed = true;
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

  private writeEndpoints(): void {
    this.app.post('/open-apis/docx/v1/documents', async (c) => {
      const gate = this.docsGate(c);
      if (gate) return gate;

      const body: unknown = await c.req.json().catch(() => ({}));
      const title = isRecord(body) && typeof body.title === 'string' ? body.title : '';
      if (title === '') return c.json({ code: 10002, msg: 'title is required' });
      const folderToken =
        isRecord(body) && typeof body.folder_token === 'string' ? body.folder_token : undefined;
      const docId = `doc_${randomUUID()}`;
      this.docs.push({
        doc_id: docId,
        title,
        content: '',
        owner_id: 'mock-owner',
        doc_type: 'docx',
        edited_at: new Date().toISOString(),
        ...(folderToken !== undefined ? { folder_id: folderToken } : {}),
      });
      return c.json({
        code: 0,
        msg: 'ok',
        data: {
          document: {
            document_id: docId,
            title,
            url: `https://fake.feishu.local/docx/${docId}`,
          },
        },
      });
    });

    this.app.get('/open-apis/docx/v1/documents/:docId/blocks', (c) => {
      const gate = this.docsGate(c);
      if (gate) return gate;
      const doc = this.requireDoc(c.req.param('docId'));
      if (!doc) return c.json({ code: 10662, msg: 'document not found' });
      // v1 mock model: every document has one root text block.
      return c.json({
        code: 0,
        msg: 'ok',
        data: {
          items: [{ block_id: 'root', block_type: 2, has_child: true, parent_id: null }],
        },
      });
    });

    this.app.post('/open-apis/docx/v1/documents/:docId/blocks/:blockId/children', async (c) => {
      const gate = this.docsGate(c);
      if (gate) return gate;
      const doc = this.requireDoc(c.req.param('docId'));
      if (!doc) return notFound();
      if (this.lockedDocs.has(doc.doc_id)) return locked();

      const body: unknown = await c.req.json().catch(() => ({}));
      const children = isRecord(body) && Array.isArray(body.children) ? body.children : [];
      const appended = appendText(children);
      doc.content = doc.content === '' ? appended : `${doc.content}\n${appended}`;
      doc.edited_at = new Date().toISOString();
      return c.json({ code: 0, msg: 'ok', data: { children: [] } });
    });

    this.app.patch('/open-apis/docx/v1/documents/:docId', async (c) => {
      const gate = this.docsGate(c);
      if (gate) return gate;
      const doc = this.requireDoc(c.req.param('docId'));
      if (!doc) return notFound();
      if (this.lockedDocs.has(doc.doc_id)) return locked();

      const body: unknown = await c.req.json().catch(() => ({}));
      const title = isRecord(body) && typeof body.title === 'string' ? body.title : '';
      if (title === '') return c.json({ code: 10002, msg: 'title is required' });
      doc.title = title;
      doc.edited_at = new Date().toISOString();
      return c.json({
        code: 0,
        msg: 'ok',
        data: {
          document: {
            document_id: doc.doc_id,
            title: doc.title,
            url: `https://fake.feishu.local/docx/${doc.doc_id}`,
          },
        },
      });
    });

    this.app.post('/open-apis/drive/v1/files/:fileToken/move', async (c) => {
      const gate = this.docsGate(c);
      if (gate) return gate;
      const doc = this.requireDoc(c.req.param('fileToken'));
      if (!doc) return notFound();
      if (this.lockedDocs.has(doc.doc_id)) return locked();

      const body: unknown = await c.req.json().catch(() => ({}));
      const folderToken =
        isRecord(body) && typeof body.folder_token === 'string' ? body.folder_token : '';
      if (folderToken === '') return c.json({ code: 10002, msg: 'folder_token is required' });
      doc.folder_id = folderToken;
      doc.edited_at = new Date().toISOString();
      return c.json({ code: 0, msg: 'ok', data: { task_id: `task_${randomUUID()}` } });
    });
  }

  private advancedEndpoints(): void {
    this.app.post('/open-apis/drive/v1/export_tasks', async (c) => {
      const gate = this.docsGate(c);
      if (gate) return gate;

      const body: unknown = await c.req.json().catch(() => ({}));
      const token = isRecord(body) && typeof body.token === 'string' ? body.token : '';
      const extension =
        isRecord(body) && typeof body.file_extension === 'string' ? body.file_extension : '';
      if (token === '' || extension === '') {
        return c.json({ code: 10002, msg: 'token and file_extension are required' });
      }
      if (!this.requireDoc(token)) return notFound();

      const ticket = `ticket_${randomUUID()}`;
      const fileToken = `exported_${randomUUID()}`;
      if (this.failNextExportArmed) {
        this.failNextExportArmed = false;
        this.exports.set(ticket, { status: 2, fileToken });
      } else if (this.holdNextExportArmed) {
        this.holdNextExportArmed = false;
        this.exports.set(ticket, { status: 1, fileToken });
      } else {
        this.exports.set(ticket, { status: 0, fileToken });
      }
      return c.json({ code: 0, msg: 'ok', data: { ticket } });
    });

    this.app.get('/open-apis/drive/v1/export_tasks/:ticket', (c) => {
      const gate = this.docsGate(c);
      if (gate) return gate;

      const exportTask = this.exports.get(c.req.param('ticket'));
      if (!exportTask) return notFound();
      // A held export completes on its second poll.
      const status = exportTask.status;
      if (status === 1) {
        exportTask.status = 0;
        return c.json({ code: 0, msg: 'ok', data: { job_status: 1 } });
      }
      if (status === 2) {
        return c.json({ code: 0, msg: 'ok', data: { job_status: 2, msg: 'export failed' } });
      }
      return c.json({
        code: 0,
        msg: 'ok',
        data: { job_status: 0, result: { file_token: exportTask.fileToken } },
      });
    });

    this.app.get('/open-apis/sheets/v2/spreadsheets/:token/values/:range', (c) => {
      const gate = this.docsGate(c);
      if (gate) return gate;

      const sheet = this.sheets.get(c.req.param('token'));
      if (!sheet) return notFound();
      const range = c.req.param('range');
      const ref = parseRange(range);
      if (!ref || (ref.sheet !== undefined && ref.sheet !== sheet.sheetName)) return notFound();
      return c.json({
        code: 0,
        msg: 'ok',
        data: { valueRange: { range, values: sliceValues(sheet.values, ref) } },
      });
    });

    this.app.put('/open-apis/sheets/v2/spreadsheets/:token/values', async (c) => {
      const gate = this.docsGate(c);
      if (gate) return gate;

      const sheet = this.sheets.get(c.req.param('token'));
      if (!sheet) return notFound();

      const body: unknown = await c.req.json().catch(() => ({}));
      const valueRange = isRecord(body) && isRecord(body.valueRange) ? body.valueRange : {};
      const range = typeof valueRange.range === 'string' ? valueRange.range : '';
      const values = Array.isArray(valueRange.values) ? (valueRange.values as CellValue[][]) : [];
      const ref = parseRange(range);
      if (!ref || (ref.sheet !== undefined && ref.sheet !== sheet.sheetName)) return notFound();
      if (!values.every((row) => Array.isArray(row))) {
        return c.json({ code: 10002, msg: 'values must be a 2-D array' });
      }
      // The written matrix must match the range's shape (height × width);
      // silent padding would hide agent mistakes (T9 review finding).
      const height = ref.rowEnd - ref.rowStart + 1;
      const width = ref.colEnd - ref.colStart + 1;
      if (values.length !== height || values.some((row) => row.length !== width)) {
        return c.json({
          code: 10002,
          msg: `values shape (${values.length} x ${values[0]?.length ?? 0}) does not match range "${range}" (${height} x ${width})`,
        });
      }
      const updated = writeValues(sheet.values, ref, values);
      return c.json({
        code: 0,
        msg: 'ok',
        data: {
          spreadsheetToken: c.req.param('token'),
          updatedRange: range,
          updatedRows: updated.updatedRows,
          updatedColumns: updated.updatedColumns,
          updatedCells: updated.updatedCells,
        },
      });
    });

    this.app.get('/open-apis/bitable/v1/apps/:app/tables', (c) => {
      const gate = this.docsGate(c);
      if (gate) return gate;

      const tables = this.bitables.get(c.req.param('app'));
      if (!tables) return notFound();
      return c.json({
        code: 0,
        msg: 'ok',
        data: { items: tables.map((table) => ({ table_id: table.tableId, name: table.name })) },
      });
    });

    this.app.get('/open-apis/bitable/v1/apps/:app/tables/:tableId/records', (c) => {
      const gate = this.docsGate(c);
      if (gate) return gate;

      const table = this.requireBitableTable(c.req.param('app'), c.req.param('tableId'));
      if (!table) return notFound();
      const pageSize = Number(c.req.query('page_size') ?? 100) || 100;
      return c.json({
        code: 0,
        msg: 'ok',
        data: {
          items: table.records.slice(0, pageSize),
          has_more: false,
        },
      });
    });

    this.app.post('/open-apis/bitable/v1/apps/:app/tables/:tableId/records', async (c) => {
      const gate = this.docsGate(c);
      if (gate) return gate;

      const table = this.requireBitableTable(c.req.param('app'), c.req.param('tableId'));
      if (!table) return notFound();

      const body: unknown = await c.req.json().catch(() => ({}));
      const fields = isRecord(body) && isRecord(body.fields) ? body.fields : {};
      const record = { record_id: `rec_${randomUUID()}`, fields };
      table.records.push(record);
      return c.json({ code: 0, msg: 'ok', data: { record } });
    });
  }

  private requireBitableTable(
    appToken: string,
    tableId: string,
  ): { name: string; tableId: string; records: Array<{ record_id: string; fields: Record<string, unknown> }> } | undefined {
    return this.bitables.get(appToken)?.find((table) => table.tableId === tableId);
  }

  private requireDoc(docId: string): MockFeishuDoc | undefined {
    return this.docs.find((d) => d.doc_id === docId);
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

/** 10662 envelope: document not found. */
function notFound(): Response {
  return new Response(JSON.stringify({ code: 10662, msg: 'document not found' }), {
    headers: { 'content-type': 'application/json' },
  });
}

/** 10667 envelope: document locked. */
function locked(): Response {
  return new Response(JSON.stringify({ code: 10667, msg: 'document locked' }), {
    headers: { 'content-type': 'application/json' },
  });
}

/** FormData field as a string, or '' when absent. */
function field(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
}

/**
 * Extracts the concatenated text from a docx children payload
 * (block_type 2 text blocks with text_run elements) — the append contract
 * the connector sends.
 */
function appendText(children: unknown[]): string {
  return children
    .map((child) => {
      if (!isRecord(child) || !isRecord(child.text)) return '';
      const elements = Array.isArray(child.text.elements) ? child.text.elements : [];
      return elements
        .map((element) => {
          if (!isRecord(element) || !isRecord(element.text_run)) return '';
          return typeof element.text_run.content === 'string' ? element.text_run.content : '';
        })
        .join('');
    })
    .join('');
}
