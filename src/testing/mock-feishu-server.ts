import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Context } from 'hono';
import { randomUUID } from 'node:crypto';
import { isRecord } from '../admin/util.js';
import { parseRange, sliceValues, writeValues, type RangeRef } from './range.js';
import type { CellValue } from '../actions.js';
import type { DownloadedFile } from '../upstream-http.js';

const INVALID_TOKEN_ENVELOPE = { code: 99991672, msg: 'invalid access token' };

/** Real export-task extension options (T9 demo pass): no markdown export. */
const EXPORT_EXTENSIONS = new Set(['docx', 'pdf', 'xlsx', 'csv', 'base', 'pptx']);

/** MIME types the mock reports for exported artifacts, keyed by extension. */
const EXPORT_CONTENT_TYPES: Record<string, string> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pdf: 'application/pdf',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

/** Deterministic artifact bytes for an export (#43): the connector round-trips them. */
function mockExportBytes(extension: string, fileToken: string): Uint8Array {
  return new TextEncoder().encode(`MOCK-EXPORT-${extension}-${fileToken}`);
}

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

/** A docx text element: a text_run with optional styling. */
export interface MockTextElement {
  text_run: { content: string; text_element_style?: Record<string, unknown> };
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
  /** Root Page block elements (defaults to one plain element of `title`); set to model styled titles (#41). */
  root_elements?: MockTextElement[];
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
  /** Messages received by the IM endpoint (ADR-0016): receive_id_type, id, text content. */
  sentMessages: Array<{ receiveIdType: string; receiveId: string; content: string }> = [];
  /** Body of the last block PATCH (rename): pins the elements the connector sends (#41). */
  lastBlockPatch: unknown;

  private readonly accessTokenTtlMs: number;
  private readonly refreshTokenTtlMs: number;
  private readonly issuedCodes = new Set<string>();
  private readonly refreshTokens = new Map<string, { active: boolean }>();
  private readonly issuedAccessTokens = new Set<string>();
  private readonly docs: MockFeishuDoc[] = [];
  private readonly lockedDocs = new Set<string>();
  private readonly sheets = new Map<
    string,
    { sheetId: string; sheetName: string; values: CellValue[][] }
  >();
  private readonly bitables = new Map<string, Array<{ name: string; tableId: string; records: Array<{ record_id: string; fields: Record<string, unknown> }> }>>();
  private readonly exports = new Map<string, { status: number; fileToken: string }>();
  /** Downloadable export artifacts keyed by exported file token (#43). */
  private readonly artifacts = new Map<string, DownloadedFile>();
  private readonly moveTasks = new Map<string, { status: 'success' | 'process' | 'fail' }>();
  private holdNextExportArmed = false;
  private failNextExportArmed = false;
  private holdNextMoveArmed = false;
  private failNextMoveArmed = false;
  private holdNextDeleteArmed = false;
  private failNextDeleteArmed = false;
  private omitRefreshTokenArmed = false;
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
    this.imEndpoints();
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
  seedSheet(
    docId: string,
    title: string,
    sheetName: string,
    values: CellValue[][],
    sheetId = `sht_${docId}`,
  ): void {
    this.docs.push({
      doc_id: docId,
      title,
      content: '',
      owner_id: 'mock-owner',
      doc_type: 'sheet',
      edited_at: new Date().toISOString(),
    });
    this.sheets.set(docId, { sheetId, sheetName, values: values.map((row) => [...row]) });
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

  /**
   * Replaces a downloadable artifact's bytes (#43): tests arm oversized
   * payloads (the connector's cap) or custom content types.
   */
  setArtifactBytes(fileToken: string, bytes: Uint8Array, contentType: string): void {
    this.artifacts.set(fileToken, { bytes, contentType });
  }

  /** Holds the next move task in the running state (status "process"). */
  holdNextMove(): void {
    this.holdNextMoveArmed = true;
  }

  /** Fails the next move task (status "fail"). */
  failNextMove(): void {
    this.failNextMoveArmed = true;
  }

  /** Holds the next delete task in the running state (#44). */
  holdNextDelete(): void {
    this.holdNextDeleteArmed = true;
  }

  /** Fails the next delete task (#44). */
  failNextDelete(): void {
    this.failNextDeleteArmed = true;
  }

  /** Next token envelope omits refresh_token (app-config simulation). */
  omitRefreshTokenNext(): void {
    this.omitRefreshTokenArmed = true;
  }

  /** Scripts one failure for the next docs endpoint call. */
  failNextDocs(failure: ScriptedFailure): void {
    this.scriptedDocsFailure = failure;
  }

  private docsEndpoints(): void {
    // The test_connection probe (T10): the cheapest drive call in scope,
    // mirroring the connector's page_size=1 files list.
    this.app.get('/open-apis/drive/v1/files', (c) => {
      const gate = this.docsGate(c);
      if (gate) return gate;

      const pageSize = Number(c.req.query('page_size') ?? 50) || 50;
      const files = this.docs.slice(0, pageSize).map((doc) => ({
        token: doc.doc_id,
        type: doc.doc_type,
        name: doc.title,
      }));
      return c.json({
        code: 0,
        msg: 'ok',
        data: { files, has_more: this.docs.length > pageSize, next_page_token: '' },
      });
    });

    this.app.post('/open-apis/drive/v1/files/search', async (c) => {
      const gate = this.docsGate(c);
      if (gate) return gate;

      const body: unknown = await c.req.json().catch(() => ({}));
      const searchKey =
        isRecord(body) && typeof body.search_key === 'string' ? body.search_key : '';
      const pageSize = Number(c.req.query('page_size') ?? 50) || 50;
      const offset = Number(c.req.query('page_token') ?? '0') || 0;
      const needle = searchKey.toLowerCase();
      const matches = this.docs
        .filter((doc) => doc.title.toLowerCase().includes(needle))
        .sort((a, b) => b.edited_at.localeCompare(a.edited_at));
      const page = matches.slice(offset, offset + pageSize);
      const hasMore = offset + page.length < matches.length;
      const docsEntities = page.map((doc) => ({
        docs_token: doc.doc_id,
        docs_type: doc.doc_type,
        title: doc.title,
        owner_id: doc.owner_id,
      }));
      // Real contract: has_more + page_token drive cursor pagination (#42);
      // page_token is the offset of the next page.
      return c.json({
        code: 0,
        msg: 'ok',
        data: {
          docs_entities: docsEntities,
          has_more: hasMore,
          page_token: hasMore ? String(offset + pageSize) : '',
          total: matches.length,
        },
      });
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
        // Fidelity: the requested doc_type must match the stored doc's
        // type — a wrong type answers not-found exactly like a missing
        // token (the connector probes candidates in order per #41).
        if (typeof request.doc_type === 'string' && request.doc_type !== doc.doc_type) {
          return c.json({ code: 10662, msg: 'document not found' });
        }
        metas.push({
          doc_token: doc.doc_id,
          doc_type: doc.doc_type,
          title: doc.title,
          owner_id: doc.owner_id,
          latest_modify_time: doc.edited_at,
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
          document: { document_id: docId, revision_id: 1, title },
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

    this.app.get('/open-apis/docx/v1/documents/:docId/blocks/:blockId', (c) => {
      const gate = this.docsGate(c);
      if (gate) return gate;
      const doc = this.requireDoc(c.req.param('docId'));
      if (!doc) return notFound();
      // Real contract: the root Page block's id equals the document id —
      // the single-block GET returns its rich-text elements (the title).
      if (c.req.param('blockId') !== doc.doc_id) return notFound();
      return c.json({
        code: 0,
        msg: 'ok',
        data: {
          block: {
            block_id: doc.doc_id,
            block_type: 1,
            parent_id: '',
            page: { elements: this.rootElements(doc) },
          },
        },
      });
    });

    this.app.patch('/open-apis/docx/v1/documents/:docId/blocks/:blockId', async (c) => {
      const gate = this.docsGate(c);
      if (gate) return gate;
      const doc = this.requireDoc(c.req.param('docId'));
      if (!doc) return notFound();
      if (this.lockedDocs.has(doc.doc_id)) return locked();

      // Real contract (T9 demo pass): renaming patches the root Page block
      // (block_id == document_id) with update_text_elements.
      if (c.req.param('blockId') !== doc.doc_id) return notFound();
      const body: unknown = await c.req.json().catch(() => ({}));
      this.lastBlockPatch = body;
      const update =
        isRecord(body) && isRecord(body.update_text_elements) ? body.update_text_elements : {};
      const elements = Array.isArray(update.elements) ? (update.elements as MockTextElement[]) : [];
      if (elements.length === 0) return c.json({ code: 10002, msg: 'content is required' });
      // Fidelity: update_text_elements REPLACES the elements with what is
      // sent — the connector must send the full array (#41). The title is
      // the concatenation of all text_run contents.
      doc.root_elements = elements;
      doc.title = elements
        .map((element) => element?.text_run?.content ?? '')
        .join('');
      doc.edited_at = new Date().toISOString();
      return c.json({
        code: 0,
        msg: 'ok',
        data: {
          block: {
            block_id: doc.doc_id,
            block_type: 1,
            parent_id: '',
            page: { elements: elements.map((element) => ({ ...element })) },
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
      // Real contract: a mismatched or empty type fails the move
      // (params error) — the connector must probe the real file type.
      const type = isRecord(body) && typeof body.type === 'string' ? body.type : '';
      if (type !== doc.doc_type) {
        return c.json({ code: 1061002, msg: 'file type mismatch' });
      }
      doc.folder_id = folderToken;
      doc.edited_at = new Date().toISOString();
      // Real contract: the move is async — the task completes via
      // task_check. The mock applies the move immediately; the task's
      // status only gates verification (scriptable below).
      const taskId = `task_${randomUUID()}`;
      let status: 'success' | 'process' | 'fail' = 'success';
      if (this.failNextMoveArmed) {
        this.failNextMoveArmed = false;
        status = 'fail';
      } else if (this.holdNextMoveArmed) {
        this.holdNextMoveArmed = false;
        status = 'process';
      }
      this.moveTasks.set(taskId, { status });
      return c.json({ code: 0, msg: 'ok', data: { task_id: taskId } });
    });

    // Real contract (#44, doc-verified): drive file delete is
    // DELETE /files/:token?type=<type>; deletion moves the file to the
    // system trash; the response carries a task_id verified via the same
    // task_check endpoint as moves. The type must be the file's real type
    // (mismatch fails), so the connector probes first like move/export.
    this.app.delete('/open-apis/drive/v1/files/:fileToken', (c) => {
      const gate = this.docsGate(c);
      if (gate) return gate;
      const doc = this.requireDoc(c.req.param('fileToken'));
      if (!doc) return notFound();
      if (this.lockedDocs.has(doc.doc_id)) return locked();

      const type = c.req.query('type') ?? '';
      if (type !== doc.doc_type) {
        return c.json({ code: 1061002, msg: 'file type mismatch' });
      }
      const index = this.docs.indexOf(doc);
      this.docs.splice(index, 1);
      this.sheets.delete(doc.doc_id);
      this.bitables.delete(doc.doc_id);
      const taskId = `task_${randomUUID()}`;
      let status: 'success' | 'process' | 'fail' = 'success';
      if (this.failNextDeleteArmed) {
        this.failNextDeleteArmed = false;
        status = 'fail';
      } else if (this.holdNextDeleteArmed) {
        this.holdNextDeleteArmed = false;
        status = 'process';
      }
      this.moveTasks.set(taskId, { status });
      return c.json({ code: 0, msg: 'ok', data: { task_id: taskId } });
    });

    // Real contract: drive async-task status. status is a STRING —
    // "success", "fail" (task done, failed), or "process" (running).
    this.app.get('/open-apis/drive/v1/files/task_check', (c) => {
      const gate = this.docsGate(c);
      if (gate) return gate;

      const taskId = c.req.query('task_id') ?? '';
      const task = this.moveTasks.get(taskId);
      if (!task) return c.json({ code: 1061003, msg: 'task not found' });
      // A held move completes on its second poll.
      const status = task.status;
      if (status === 'process') {
        task.status = 'success';
      }
      return c.json({ code: 0, msg: 'ok', data: { status } });
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
      const type = isRecord(body) && typeof body.type === 'string' ? body.type : '';
      // Real contract (T9 demo pass): type (source) is required and the
      // extension must be in Feishu's option list (no markdown export).
      if (type === '') {
        return c.json({ code: 99992402, msg: 'field validation failed' });
      }
      if (!EXPORT_EXTENSIONS.has(extension)) {
        return c.json({ code: 99992402, msg: 'field validation failed' });
      }
      if (token === '') return c.json({ code: 10002, msg: 'token is required' });
      const sourceDoc = this.requireDoc(token);
      if (!sourceDoc) return notFound();
      // Real contract: the source type must match the file's real type —
      // the connector must probe it instead of hardcoding docx.
      if (type !== sourceDoc.doc_type) {
        return c.json({ code: 99992402, msg: 'field validation failed' });
      }

      const ticket = `ticket_${randomUUID()}`;
      const fileToken = `exported_${randomUUID()}`;
      // #43: a completed export produces a downloadable artifact keyed by
      // the exported file token (the medias download surface).
      this.artifacts.set(fileToken, {
        bytes: mockExportBytes(extension, fileToken),
        contentType: EXPORT_CONTENT_TYPES[extension] ?? 'application/octet-stream',
      });
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

      // Real contract (T9 demo pass): the poll requires the source doc's
      // token as a query parameter (99992402 without it).
      const token = c.req.query('token');
      if (!token || !this.requireDoc(token)) {
        return c.json({ code: 99992402, msg: 'field validation failed' });
      }
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
      // Real contract (T9 demo pass): completed tasks drop job_status and
      // carry only result.file_token.
      return c.json({
        code: 0,
        msg: 'ok',
        data: { result: { file_token: exportTask.fileToken } },
      });
    });

    // Real contract (T9 demo pass): the medias download serves the
    // exported file's bytes for the connection's token (#43 closes the
    // loop: the platform fetches what the agent cannot).
    this.app.get('/open-apis/drive/v1/medias/:fileToken/download', (c) => {
      const gate = this.docsGate(c);
      if (gate) return gate;

      const artifact = this.artifacts.get(c.req.param('fileToken'));
      if (!artifact) return notFound();
      return new Response(artifact.bytes, {
        headers: { 'content-type': artifact.contentType },
      });
    });

    // Real contract (T9 demo pass): the values API resolves sheets by
    // SHEET ID only — a display name in the range returns 90215. Bare
    // ranges fall back to the first sheet.
    this.app.get('/open-apis/sheets/v2/spreadsheets/:token/values/:range', (c) => {
      const gate = this.docsGate(c);
      if (gate) return gate;

      const sheet = this.sheets.get(c.req.param('token'));
      if (!sheet) return notFound();
      const range = c.req.param('range');
      const sheetForRange = this.resolveSheetByRange(sheet, range);
      if (!sheetForRange) {
        return c.json({ code: 90215, msg: 'not found sheetId' });
      }
      return c.json({
        code: 0,
        msg: 'ok',
        data: { valueRange: { range, values: sliceValues(sheetForRange.values, sheetForRange.ref) } },
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
      const sheetForRange = this.resolveSheetByRange(sheet, range);
      if (!sheetForRange) {
        return c.json({ code: 90215, msg: 'not found sheetId' });
      }
      const ref = sheetForRange.ref;
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
      const updated = writeValues(sheetForRange.values, ref, values);
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

    this.app.get('/open-apis/sheets/v3/spreadsheets/:token/sheets/query', (c) => {
      const gate = this.docsGate(c);
      if (gate) return gate;

      const sheet = this.sheets.get(c.req.param('token'));
      if (!sheet) return notFound();
      return c.json({
        code: 0,
        msg: 'ok',
        data: { sheets: [{ sheet_id: sheet.sheetId, title: sheet.sheetName, index: 0 }] },
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

    this.app.put('/open-apis/bitable/v1/apps/:app/tables/:tableId/records/:recordId', async (c) => {
      const gate = this.docsGate(c);
      if (gate) return gate;

      const table = this.requireBitableTable(c.req.param('app'), c.req.param('tableId'));
      if (!table) return notFound();
      const record = table.records.find((r) => r.record_id === c.req.param('recordId'));
      if (!record) return notFound();

      const body: unknown = await c.req.json().catch(() => ({}));
      const fields = isRecord(body) && isRecord(body.fields) ? body.fields : {};
      // Real contract: the update overwrites only the provided fields;
      // others keep their current values.
      record.fields = { ...record.fields, ...fields };
      return c.json({ code: 0, msg: 'ok', data: { record: { record_id: record.record_id, fields: { ...record.fields } } } });
    });

    this.app.get('/open-apis/bitable/v1/apps/:app/tables/:tableId/records', (c) => {
      const gate = this.docsGate(c);
      if (gate) return gate;

      const table = this.requireBitableTable(c.req.param('app'), c.req.param('tableId'));
      if (!table) return notFound();
      const pageSize = Number(c.req.query('page_size') ?? 100) || 100;
      const offset = Number(c.req.query('page_token') ?? '0') || 0;
      const page = table.records.slice(offset, offset + pageSize);
      const hasMore = offset + page.length < table.records.length;
      // Real contract: has_more + page_token drive cursor pagination (#42);
      // page_token is the offset of the next page.
      return c.json({
        code: 0,
        msg: 'ok',
        data: {
          items: page,
          has_more: hasMore,
          page_token: hasMore ? String(offset + pageSize) : '',
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

    // Real contract (#44, doc-verified): batch delete takes a plain array
    // of record-id strings (≤500), succeeds as a unit, and returns no
    // per-record results — the count is the caller's batch size. A missing
    // record id fails the whole call; the mock pins that as the 10662
    // not-found family (live code unpinned until a demo pass).
    this.app.post(
      '/open-apis/bitable/v1/apps/:app/tables/:tableId/records/batch_delete',
      async (c) => {
        const gate = this.docsGate(c);
        if (gate) return gate;

        const table = this.requireBitableTable(c.req.param('app'), c.req.param('tableId'));
        if (!table) return notFound();

        const body: unknown = await c.req.json().catch(() => ({}));
        const ids =
          isRecord(body) && Array.isArray(body.records)
            ? body.records.filter((id): id is string => typeof id === 'string')
            : [];
        if (ids.length === 0) {
          return c.json({ code: 10002, msg: 'records is required' });
        }
        const doomed = ids.map((id) => table.records.find((r) => r.record_id === id));
        if (doomed.some((record) => record === undefined)) return notFound();
        for (const record of doomed) {
          const index = table.records.indexOf(record!);
          table.records.splice(index, 1);
        }
        return c.json({ code: 0, msg: 'ok', data: {} });
      },
    );
  }

  /**
   * Resolves a range's sheet reference: a bare cell range means the first
   * sheet; a prefixed range must use the SHEET ID (names return the real
   * API's 90215). Returns the target values + parsed range, or undefined.
   */
  private resolveSheetByRange(
    sheet: { sheetId: string; sheetName: string; values: CellValue[][] },
    range: string,
  ): { values: CellValue[][]; ref: RangeRef } | undefined {
    const ref = parseRange(range);
    if (!ref) return undefined;
    if (ref.sheet === undefined) {
      return { values: sheet.values, ref };
    }
    if (ref.sheet !== sheet.sheetId) return undefined;
    return { values: sheet.values, ref };
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

  /** The doc's root Page block elements, defaulting to one plain run of its title. */
  private rootElements(doc: MockFeishuDoc): MockTextElement[] {
    return doc.root_elements ?? [{ text_run: { content: doc.title } }];
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

  /**
   * The IM send surface (ADR-0016): `POST /im/v1/messages` — the mock
   * records each accepted message so tests pin the connector's request
   * shape (receive_id_type, receive_id, JSON-encoded text content).
   */
  private imEndpoints(): void {
    this.app.post('/open-apis/im/v1/messages', async (c) => {
      const gate = this.docsGate(c);
      if (gate) return gate;

      const body: unknown = await c.req.json().catch(() => ({}));
      const receiveId = isRecord(body) && typeof body.receive_id === 'string' ? body.receive_id : '';
      if (receiveId === '') {
        // Fidelity: the live API rejects a missing receive_id with the
        // generic invalid-parameter envelope (230001).
        return c.json({ code: 230001, msg: 'invalid request parameter' });
      }
      let textContent = '';
      if (isRecord(body) && typeof body.content === 'string') {
        const parsed: unknown = JSON.parse(body.content);
        if (isRecord(parsed) && typeof parsed.text === 'string') textContent = parsed.text;
      }
      this.sentMessages.push({
        receiveIdType: c.req.query('receive_id_type') ?? '',
        receiveId,
        content: textContent,
      });
      return c.json({ code: 0, msg: 'ok', data: { message_id: `om_${randomUUID()}` } });
    });
  }

  /**
   * The v2 token endpoint's success body (live-verified in the T9 demo
   * pass): FLAT OAuth-style fields at the top level with a trailing code —
   * not the {code, msg, data} envelope the mock previously modelled.
   */
  private tokenEnvelope(): {
    token_type: string;
    access_token: string;
    refresh_token?: string;
    refresh_token_expires_in?: number;
    expires_in: number;
    code: number;
  } {
    const accessToken = `mock_access_${randomUUID()}`;
    const refreshToken = `mock_refresh_${randomUUID()}`;
    this.refreshTokens.set(refreshToken, { active: true });
    this.issuedAccessTokens.add(accessToken);
    const envelope: {
      token_type: string;
      access_token: string;
      refresh_token?: string;
      refresh_token_expires_in?: number;
      expires_in: number;
      code: number;
    } = {
      token_type: 'Bearer',
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_in: Math.floor(this.accessTokenTtlMs / 1000),
      refresh_token_expires_in: Math.floor(this.refreshTokenTtlMs / 1000),
      code: 0,
    };
    if (this.omitRefreshTokenArmed) {
      this.omitRefreshTokenArmed = false;
      delete envelope.refresh_token;
      delete envelope.refresh_token_expires_in;
    }
    return envelope;
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
