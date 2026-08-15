import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Context } from 'hono';
import { randomUUID } from 'node:crypto';
import type { CellValue } from '../actions.js';
import { isRecord } from '../admin/util.js';
import type { DownloadedFile } from '../upstream-http.js';
import { parseRange, sliceValues, writeValues } from './range.js';

/** DingTalk v1.0 API error shape: HTTP status + `{code, message}`. */
interface DingTalkErrorBody {
  code: string;
  message: string;
}

const INVALID_AUTH = { code: 'InvalidAuthentication', message: 'invalid access token' } satisfies DingTalkErrorBody;

/** MIME types the mock reports for export artifacts, keyed by exportType. */
const EXPORT_CONTENT_TYPES: Record<string, string> = {
  dingTalkDocToDocx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  dingTalkDocToPdf: 'application/pdf',
};

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
  /**
   * The app robot's console robotCode (#49). When set, the robot
   * send API only accepts matching robotCodes; unset means no robot is
   * configured for this app (every robotCode is rejected).
   */
  robotCode?: string;
}

/** A seeded online document in the mock's DingTalk knowledge base (T17b). */
export interface MockDingTalkDoc {
  /** The document identity: the dentryUuid (node id) — the platform's opaque doc_id. */
  docKey: string;
  name: string;
  /** Markdown content — the blocks endpoint derives blocks from this. */
  content: string;
  /** The owning user's unionId. */
  ownerUnionId: string;
  /** The space the doc lives in (wiki workspaceId namespace). */
  spaceId?: string;
  /** The parent dentry (folder) the doc lives under, if any. */
  parentDentryId?: string;
  /** Epoch ms timestamps (DingTalk's Long shapes). */
  createdTime?: number;
  updatedTime?: number;
}

/** A seeded folder in the mock's DingTalk knowledge base (T17c live pass). */
export interface MockDingTalkFolder {
  folderId: string;
  /** The 16-char storage dentryId the create API's parentDentryId wants. */
  dentryId: string;
  name: string;
  spaceId: string;
}

/** A seeded worksheet in a mock workbook (T18a). */
export interface MockDingTalkSheet {
  /** The sheet id (the `id` the sheets-list returns). */
  id: string;
  /** The display name — the range APIs accept the NAME in the sheetId slot. */
  name: string;
  /** The cell matrix, row-major, native JSON value types (live shape). */
  values: CellValue[][];
}

/** A seeded workbook in the mock's DingTalk knowledge base (T18a). */
export interface MockDingTalkWorkbook {
  /** The workbook identity: the dentryUuid (node id) — the platform's opaque doc_id. */
  workbookId: string;
  name: string;
  ownerUnionId: string;
  /** The worksheets in display order — the first one is the default target. */
  sheets: MockDingTalkSheet[];
}

/**
 * A seeded group chat the app robot can message (#49). The chat universe
 * mirrors the constraint from the spec: only groups the app created or
 * learned via message events exist, and the robot must be a member.
 */
export interface MockDingTalkChat {
  /** The openConversationId — the platform's opaque chat_id. */
  openConversationId: string;
  /** Whether the app robot is a member (it must be, to send). Defaults to true. */
  robotInGroup?: boolean;
}

/** A robot-sent group message the mock recorded (#49). */
export interface RecordedGroupMessage {
  openConversationId: string;
  robotCode: string;
  msgKey: string;
  content: string;
}

/**
 * Seam B (T17a): an in-memory mock of the DingTalk Open Platform surface
 * used by the connection tests — the OAuth 2.0 authorize redirect, the
 * userAccessToken endpoint (code exchange + refresh), the app-token
 * endpoint (client credentials, T17 live pass), and the identity + doc
 * surface — so no real DingTalk credentials are needed in CI.
 *
 * The mock mirrors DingTalk's shapes (live-confirmed during the T17 live
 * pass): the USER token authenticates only the identity API (`users/me`);
 * the APP token authenticates the doc/wiki/storage APIs together with the
 * acting user's `operatorId` (missing operatorId → 400 MissingoperatorId).
 *
 * Doc surface (live shapes):
 * - `POST /v2.0/storage/dentries/search` → `{items, nextToken}` — items
 *   carry `{dentryUuid, name, creator{userId}, modifier{userId}, path}`
 *   and NO contentType/docKey (the connector therefore does not filter);
 * - `GET /v2.0/wiki/nodes/{nodeId}` → node info (name, workspaceId,
 *   creatorId, ISO createTime/modifiedTime, type, category, extension);
 * - `POST /v2.0/doc/spaces/{spaceId}/dentries` → DentryVO (dentryUuid,
 *   docKey, name WITH the `.adoc` extension, contentType 'alidoc',
 *   creator.unionId); `parentDentryId` takes the folder's 16-char
 *   dentryId (resolved via `GET /v2.0/doc/dentries/{uuid}/queryDentryId`);
 * - `POST .../dentries/{id}/rename|move` (dentryUuid ids);
 * - `GET /v1.0/doc/suites/documents/{id}/blocks` → blocks (paragraph /
 *   heading) derived from the stored markdown — the connector's
 *   content-read path (blocks → markdown);
 * - `POST /v1.0/doc/suites/documents/{id}/content` → `{success, result}`
 *   (markdown insert, no path/index = append at the end).
 *
 * Workbook surface (T18a, official-docs shapes — same app-token +
 * operatorId auth model):
 * - `GET /v1.0/doc/workbooks/{workbookId}/sheets` → `{value: [{id, name}]}`
 *   (worksheet list in display order; the connector resolves the first
 *   worksheet through this when sheet_name is omitted);
 * - `GET /v1.0/doc/workbooks/{workbookId}/sheets/{sheetId}/ranges/
 *   {rangeAddress}?select=values&operatorId=` → `{values: any[][]}` — the
 *   sheetId slot accepts the sheet ID **or** the sheet NAME directly (the
 *   connector therefore passes an explicit sheet_name through unchanged);
 * - `PUT .../ranges/{rangeAddress}?operatorId=` body `{values}` →
 *   `{a1Notation}` — DingTalk returns NO cell count, so the connector
 *   computes updated_cells from the submitted values (recorded finding).
 *
 * The live pass corrected several mock-modeled shapes (search `dentries`
 * → `items`, v1.0 doc-family GET endpoints do not exist, the app-token
 * auth model); this file tracks the confirmed shapes.
 */
export class MockDingTalkServer {
  /** The mock's "我的文档" (my documents) workspace id. */
  static readonly MINE_SPACE_ID = 'space-mine';

  readonly app: Hono;
  /** Number of refresh_token grant calls received. */
  refreshRequestCount = 0;
  /** Number of authorization_code grant calls received. */
  exchangeRequestCount = 0;
  /** Number of app-token (client credentials) calls received. */
  appTokenRequestCount = 0;
  /** Robot-sent group messages, in send order (#49) — pins the connector's request shape. */
  sentGroupMessages: RecordedGroupMessage[] = [];

  private readonly accessTokenTtlMs: number;
  private readonly refreshTokenTtlMs: number;
  private readonly issuedCodes = new Set<string>();
  private readonly refreshTokens = new Map<string, { active: boolean }>();
  private readonly issuedAccessTokens = new Map<string, { expiresAt: number }>();
  private readonly issuedAppTokens = new Map<string, { expiresAt: number }>();
  private scriptedFailure: ScriptedFailure | undefined;
  private insertFailure: ScriptedFailure | undefined;
  private omitRefreshTokenArmed = false;
  private readonly docs: MockDingTalkDoc[] = [];
  private readonly folders: MockDingTalkFolder[] = [];
  private readonly workbooks: MockDingTalkWorkbook[] = [];
  private readonly chats: MockDingTalkChat[] = [];
  private readonly exportJobs = new Map<
    string,
    { status: string } & DownloadedFile
  >();
  /**
   * Base URL for presigned export downloadUrls (#43): when set, the task
   * query returns URLs under this base so the connector's absolute-URL
   * fetch hits the mock itself (tests set it to the live server URL).
   */
  artifactBaseUrl: string | undefined;

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

    // POST /v1.0/oauth2/accessToken — client credentials (app token). The
    // doc/wiki/storage APIs authenticate with this token (T17 live pass).
    this.app.post('/v1.0/oauth2/accessToken', async (c) => {
      const scripted = this.scriptedResponse();
      if (scripted) return scripted;
      const body = await readJson(c);
      if (!isRecord(body) || body.appKey !== options.appKey || body.appSecret !== options.appSecret) {
        return c.json({ code: 'InvalidClient', message: 'invalid client credentials' }, 400);
      }
      this.appTokenRequestCount++;
      const token = `dt_app_${randomUUID()}`;
      this.issuedAppTokens.set(token, { expiresAt: Date.now() + this.accessTokenTtlMs });
      return c.json({
        accessToken: token,
        expireIn: Math.floor(this.accessTokenTtlMs / 1000),
      });
    });

    // GET /v1.0/contact/users/me — the identity call test_connection uses.
    // USER token only (an app token gets 404, mirroring the live API).
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

    // POST /v2.0/storage/dentries/search — keyword search (app token +
    // operatorId). Live shape: {items, nextToken}; items carry dentryUuid
    // + name and NO contentType/docKey.
    this.app.post('/v2.0/storage/dentries/search', async (c) => {
      const scripted = this.scriptedResponse();
      if (scripted) return scripted;
      if (!this.isAppAuthorized(c.req.header('x-acs-dingtalk-access-token'))) {
        return c.json(INVALID_AUTH, 401);
      }
      if (!c.req.query('operatorId')) {
        return c.json({ code: 'MissingoperatorId', message: 'operatorId is mandatory for this action.' }, 400);
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
        items: matches.map((doc) => this.searchItemShape(doc)),
        nextToken: '',
      });
    });

    // GET /v2.0/wiki/nodes/{nodeId} — node info; the metadata + space
    // resolution path (nodeId = dentryUuid).
    this.app.get('/v2.0/wiki/nodes/:nodeId', (c) => {
      const scripted = this.scriptedResponse();
      if (scripted) return scripted;
      const token = c.req.header('x-acs-dingtalk-access-token');
      if (!this.isAppAuthorized(token)) {
        return c.json(INVALID_AUTH, 401);
      }
      if (!c.req.query('operatorId')) {
        return c.json({ code: 'MissingoperatorId', message: 'operatorId is mandatory for this action.' }, 400);
      }
      const nodeId = c.req.param('nodeId');
      const doc = this.docs.find((candidate) => candidate.docKey === nodeId);
      if (doc) {
        return c.json({
          node: this.nodeShape(
            doc.docKey,
            // Live finding: the wiki node name carries the `.adoc`
            // extension for online docs; the connector strips it.
            `${doc.name}.adoc`,
            'FILE',
            doc.spaceId ?? 'space-1',
            'ALIDOC',
            'adoc',
            // Live finding: node creatorId is the numeric userId, not the
            // unionId.
            '663443604826350971',
            doc.createdTime ?? 1_700_000_000_000,
            doc.updatedTime ?? 1_700_000_000_000,
          ),
        });
      }
      const folder = this.folders.find((candidate) => candidate.folderId === nodeId);
      if (folder) {
        return c.json({
          node: this.nodeShape(folder.folderId, folder.name, 'FOLDER', folder.spaceId, 'OTHER', '', 'mock-union-id'),
        });
      }
      return c.json({ code: 'NodeNotFound', message: 'node not found' }, 404);
    });

    // GET /v2.0/doc/dentries/{dentryUuid}/queryDentryId — the storage
    // dentryId the create API's parentDentryId wants (T17 live pass).
    this.app.get('/v2.0/doc/dentries/:dentryUuid/queryDentryId', (c) => {
      const scripted = this.scriptedResponse();
      if (scripted) return scripted;
      const token = c.req.header('x-acs-dingtalk-access-token');
      if (!this.isAppAuthorized(token)) {
        return c.json(INVALID_AUTH, 401);
      }
      if (!c.req.query('operatorId')) {
        return c.json({ code: 'MissingoperatorId', message: 'operatorId is mandatory for this action.' }, 400);
      }
      const uuid = c.req.param('dentryUuid');
      const folder = this.folders.find((candidate) => candidate.folderId === uuid);
      if (folder) {
        return c.json({
          dentryId: folder.dentryId,
          spaceId: `storage-${folder.spaceId}`,
          dentryUuid: uuid,
        });
      }
      return c.json({ code: 'NodeNotFound', message: 'node not found' }, 404);
    });

    // POST /v2.0/doc/spaces/{spaceId}/dentries — create a dentry
    // (documentType 0 = online document / ALIDOC; dentryType folder for
    // folders). parentDentryId takes the folder's storage dentryId.
    this.app.post('/v2.0/doc/spaces/:spaceId/dentries', async (c) => {
      const scripted = this.scriptedResponse();
      if (scripted) return scripted;
      const token = c.req.header('x-acs-dingtalk-access-token');
      if (!this.isAppAuthorized(token)) {
        return c.json(INVALID_AUTH, 401);
      }
      const spaceId = c.req.param('spaceId');
      if (!this.knownSpaces().has(spaceId)) {
        return c.json({ code: 'SpaceNotFound', message: 'space not found' }, 404);
      }
      const body = await readJson(c);
      if (!isRecord(body) || typeof body.name !== 'string' || body.name === '') {
        return c.json({ code: 'paramError', message: 'missing name' }, 400);
      }
      const operatorId = typeof body.operatorId === 'string' ? body.operatorId : undefined;
      if (!operatorId) {
        return c.json({ code: 'MissingoperatorId', message: 'operatorId is mandatory for this action.' }, 400);
      }
      const parentDentryId = typeof body.parentDentryId === 'string' ? body.parentDentryId : undefined;
      if (parentDentryId !== undefined) {
        const parent = this.folders.find((candidate) => candidate.dentryId === parentDentryId);
        if (!parent || parent.spaceId !== spaceId) {
          return c.json({ code: 'NodeNotFound', message: 'parent node not found' }, 404);
        }
      }
      const dentryType = typeof body.dentryType === 'string' ? body.dentryType : undefined;
      // The mock only serves online-doc creation (the connector never
      // creates folders — folder targets arrive as folder_id).
      if (dentryType !== undefined && dentryType !== 'file') {
        return c.json({ code: 'paramError', message: 'unsupported dentryType' }, 400);
      }
      const docKey = `dt-${randomUUID()}`;
      const doc: MockDingTalkDoc = {
        docKey,
        name: body.name,
        content: '',
        ownerUnionId: operatorId,
        spaceId,
        ...(parentDentryId !== undefined ? { parentDentryId } : {}),
      };
      this.docs.push(doc);
      return c.json(this.dentryVoShape(doc), 201);
    });

    // POST /v2.0/doc/spaces/{spaceId}/dentries/{dentryId}/rename.
    this.app.post('/v2.0/doc/spaces/:spaceId/dentries/:dentryId/rename', async (c) => {
      const scripted = this.scriptedResponse();
      if (scripted) return scripted;
      const token = c.req.header('x-acs-dingtalk-access-token');
      if (!this.isAppAuthorized(token)) {
        return c.json(INVALID_AUTH, 401);
      }
      const doc = this.findDocInSpace(c.req.param('dentryId'), c.req.param('spaceId'));
      if (!doc) {
        return c.json({ code: 'DocumentNotFound', message: 'document not found' }, 404);
      }
      const body = await readJson(c);
      if (!isRecord(body) || typeof body.name !== 'string' || body.name === '') {
        return c.json({ code: 'paramError', message: 'missing name' }, 400);
      }
      doc.name = body.name;
      return c.json(this.dentryVoShape(doc));
    });

    // POST /v2.0/doc/spaces/{spaceId}/dentries/{dentryId}/move — move into
    // a target folder (toParentDentryId = folder dentryUuid) in a target
    // space (T17 live pass shape).
    this.app.post('/v2.0/doc/spaces/:spaceId/dentries/:dentryId/move', async (c) => {
      const scripted = this.scriptedResponse();
      if (scripted) return scripted;
      const token = c.req.header('x-acs-dingtalk-access-token');
      if (!this.isAppAuthorized(token)) {
        return c.json(INVALID_AUTH, 401);
      }
      const doc = this.findDocInSpace(c.req.param('dentryId'), c.req.param('spaceId'));
      if (!doc) {
        return c.json({ code: 'DocumentNotFound', message: 'document not found' }, 404);
      }
      const body = await readJson(c);
      if (!isRecord(body) || typeof body.toParentDentryId !== 'string') {
        return c.json({ code: 'paramError', message: 'missing toParentDentryId' }, 400);
      }
      const targetSpaceId = typeof body.targetSpaceId === 'string' ? body.targetSpaceId : undefined;
      const target = this.folders.find(
        (candidate) => candidate.folderId === body.toParentDentryId,
      );
      if (!target || target.spaceId !== targetSpaceId) {
        return c.json({ code: 'NodeNotFound', message: 'target folder not found' }, 404);
      }
      doc.parentDentryId = body.toParentDentryId;
      // A cross-space move relocates the doc: node resolution must see the
      // new space afterwards (rename/move are space-scoped).
      doc.spaceId = targetSpaceId;
      return c.json(this.dentryVoShape(doc));
    });

    // GET /v1.0/doc/suites/documents/{docId}/blocks — the content-read
    // path: blocks derived from the stored markdown (paragraph / heading,
    // live-confirmed block shapes).
    this.app.get('/v1.0/doc/suites/documents/:docId/blocks', (c) => {
      const scripted = this.scriptedResponse();
      if (scripted) return scripted;
      const token = c.req.header('x-acs-dingtalk-access-token');
      if (!this.isAppAuthorized(token)) {
        return c.json(INVALID_AUTH, 401);
      }
      if (!c.req.query('operatorId')) {
        return c.json({ code: 'MissingoperatorId', message: 'operatorId is mandatory for this action.' }, 400);
      }
      const doc = this.docs.find((candidate) => candidate.docKey === c.req.param('docId'));
      if (!doc) {
        return c.json({ code: 'DocumentNotFound', message: 'document not found' }, 404);
      }
      return c.json({ result: { data: this.blocksFromMarkdown(doc.content) }, success: true });
    });

    // POST /v1.0/doc/suites/documents/{docId}/content — insert markdown
    // content. No path/index = append at the end of the document root
    // (T17c modeled shape; live-confirmed the request + response).
    this.app.post('/v1.0/doc/suites/documents/:docId/content', async (c) => {
      const insertFailure = this.insertFailure;
      if (insertFailure) {
        this.insertFailure = undefined;
        return c.json(
          { code: insertFailure.code, message: insertFailure.message },
          insertFailure.httpStatus ?? 400,
        );
      }
      const scripted = this.scriptedResponse();
      if (scripted) return scripted;
      const token = c.req.header('x-acs-dingtalk-access-token');
      if (!this.isAppAuthorized(token)) {
        return c.json(INVALID_AUTH, 401);
      }
      if (!c.req.query('operatorId')) {
        return c.json({ code: 'MissingoperatorId', message: 'operatorId is mandatory for this action.' }, 400);
      }
      const doc = this.docs.find((candidate) => candidate.docKey === c.req.param('docId'));
      if (!doc) {
        return c.json({ code: 'DocumentNotFound', message: 'document not found' }, 404);
      }
      const body = await readJson(c);
      const content =
        isRecord(body) && isRecord(body.content) && typeof body.content.content === 'string'
          ? body.content.content
          : undefined;
      if (content === undefined) {
        return c.json({ code: 'paramError', message: 'missing content' }, 400);
      }
      doc.content = doc.content === '' ? content : `${doc.content}\n\n${content}`;
      return c.json({ success: true, result: {} });
    });

    // GET /v2.0/wiki/mineWorkspaces — the acting user's "我的文档" space.
    this.app.get('/v2.0/wiki/mineWorkspaces', (c) => {
      const scripted = this.scriptedResponse();
      if (scripted) return scripted;
      const token = c.req.header('x-acs-dingtalk-access-token');
      if (!this.isAppAuthorized(token)) {
        return c.json(INVALID_AUTH, 401);
      }
      if (!c.req.query('operatorId')) {
        return c.json({ code: 'MissingoperatorId', message: 'operatorId is mandatory for this action.' }, 400);
      }
      return c.json({
        workspace: {
          workspaceId: MockDingTalkServer.MINE_SPACE_ID,
          name: '我的文档',
          rootNodeId: 'root-mine',
          corpId: 'corp-1',
        },
      });
    });

    // POST /v2.0/doc/dentries/export — create an async export task. The
    // mock accepts it (the live API 404s for this app — see connector
    // notes; #43 flipped export_doc visible regardless).
    this.app.post('/v2.0/doc/dentries/export', async (c) => {
      const scripted = this.scriptedResponse();
      if (scripted) return scripted;
      const token = c.req.header('x-acs-dingtalk-access-token');
      if (!this.isAppAuthorized(token)) {
        return c.json(INVALID_AUTH, 401);
      }
      const body = await readJson(c);
      const param = isRecord(body) && isRecord(body.param) ? body.param : undefined;
      const dentryUuid =
        param !== undefined && typeof param.dentryUuid === 'string' ? param.dentryUuid : undefined;
      if (!dentryUuid) {
        return c.json({ code: 'paramError', message: 'missing param.dentryUuid' }, 400);
      }
      const doc = this.docs.find((candidate) => candidate.docKey === dentryUuid);
      if (!doc) {
        return c.json({ code: 'DocumentNotFound', message: 'document not found' }, 404);
      }
      const jobId = `job-${randomUUID()}`;
      const exportType =
        param !== undefined && typeof param.exportType === 'string' ? param.exportType : '';
      this.exportJobs.set(jobId, {
        status: 'init',
        bytes: new TextEncoder().encode(`MOCK-DINGTALK-EXPORT-${jobId}`),
        contentType: EXPORT_CONTENT_TYPES[exportType] ?? 'application/octet-stream',
      });
      return c.json({ jobId, status: 'init' });
    });

    // GET /export/artifacts/:taskId — the presigned artifact download
    // (#43). Deliberately UNAUTHENTICATED: presigned links carry their
    // authorization in the URL, which is also why the kernel sends no
    // auth header on absolute-URL downloads.
    this.app.get('/export/artifacts/:taskId', (c) => {
      const job = this.exportJobs.get(c.req.param('taskId'));
      if (!job) {
        return c.json({ code: 'ArtifactNotFound', message: 'no such artifact' }, 404);
      }
      return new Response(job.bytes, { headers: { 'content-type': job.contentType } });
    });

    // GET /v1.0/doc/workbooks/{workbookId}/sheets — the worksheet list
    // (T18a, official-docs shape): {value: [{id, name}]}, display order.
    this.app.get('/v1.0/doc/workbooks/:workbookId/sheets', (c) => {
      const scripted = this.scriptedResponse();
      if (scripted) return scripted;
      const token = c.req.header('x-acs-dingtalk-access-token');
      if (!this.isAppAuthorized(token)) {
        return c.json(INVALID_AUTH, 401);
      }
      if (!c.req.query('operatorId')) {
        return c.json({ code: 'MissingoperatorId', message: 'operatorId is mandatory for this action.' }, 400);
      }
      const workbook = this.findWorkbook(c.req.param('workbookId'));
      if (!workbook) {
        return c.json({ code: 'invalidRequest.resource.notFound', message: 'workbook not found' }, 404);
      }
      return c.json({ value: workbook.sheets.map((sheet) => ({ id: sheet.id, name: sheet.name })) });
    });

    // GET /v1.0/doc/workbooks/{workbookId}/sheets/{sheetId}/ranges/
    // {rangeAddress} — the range read (T18a, official-docs shape):
    // ?select=values&operatorId= → {values: any[][]}. The sheetId slot
    // accepts the sheet ID or NAME (the mock resolves both).
    this.app.get('/v1.0/doc/workbooks/:workbookId/sheets/:sheetId/ranges/:rangeAddress', (c) => {
      const scripted = this.scriptedResponse();
      if (scripted) return scripted;
      const token = c.req.header('x-acs-dingtalk-access-token');
      if (!this.isAppAuthorized(token)) {
        return c.json(INVALID_AUTH, 401);
      }
      if (!c.req.query('operatorId')) {
        return c.json({ code: 'MissingoperatorId', message: 'operatorId is mandatory for this action.' }, 400);
      }
      const workbook = this.findWorkbook(c.req.param('workbookId'));
      if (!workbook) {
        return c.json({ code: 'invalidRequest.resource.notFound', message: 'workbook not found' }, 404);
      }
      const sheet = this.findSheet(workbook, c.req.param('sheetId'));
      if (!sheet) {
        return c.json({ code: 'invalidRequest.resource.notFound', message: 'sheet not found' }, 404);
      }
      const ref = parseRange(c.req.param('rangeAddress'));
      if (!ref) {
        return c.json({ code: 'invalidRequest.inputArgs.invalid', message: 'invalid range address' }, 400);
      }
      // select filters the returned fields; the connector always sends
      // select=values, and the mock only stores values — any other select
      // is rejected as an unsupported field set.
      const select = c.req.query('select');
      if (select !== undefined && select !== 'values') {
        return c.json({ code: 'invalidRequest.inputArgs.invalid', message: 'unsupported select fields' }, 400);
      }
      // Out-of-bounds cells read as null (modeled on the Feishu mock;
      // live-shape assumption — the docs only promise the values matrix).
      // Live finding (T18 live pass): cells written as strings are parsed
      // back to native types on read ('1' → 1, 'true' → true).
      return c.json({
        values: sliceValues(sheet.values, ref).map((row) => row.map(parseCellValue)),
      });
    });

    // PUT /v1.0/doc/workbooks/{workbookId}/sheets/{sheetId}/ranges/
    // {rangeAddress} — the range write (T18a, official-docs shape): body
    // {values} → {a1Notation} (NO cell count — the connector computes
    // updated_cells from the submitted values, recorded finding).
    this.app.put('/v1.0/doc/workbooks/:workbookId/sheets/:sheetId/ranges/:rangeAddress', async (c) => {
      const scripted = this.scriptedResponse();
      if (scripted) return scripted;
      const token = c.req.header('x-acs-dingtalk-access-token');
      if (!this.isAppAuthorized(token)) {
        return c.json(INVALID_AUTH, 401);
      }
      if (!c.req.query('operatorId')) {
        return c.json({ code: 'MissingoperatorId', message: 'operatorId is mandatory for this action.' }, 400);
      }
      const workbook = this.findWorkbook(c.req.param('workbookId'));
      if (!workbook) {
        return c.json({ code: 'invalidRequest.resource.notFound', message: 'workbook not found' }, 404);
      }
      const sheet = this.findSheet(workbook, c.req.param('sheetId'));
      if (!sheet) {
        return c.json({ code: 'invalidRequest.resource.notFound', message: 'sheet not found' }, 404);
      }
      const ref = parseRange(c.req.param('rangeAddress'));
      if (!ref) {
        return c.json({ code: 'invalidRequest.inputArgs.invalid', message: 'invalid range address' }, 400);
      }
      const body = await readJson(c);
      if (!isRecord(body) || !Array.isArray(body.values)) {
        return c.json({ code: 'invalidRequest.inputArgs.invalid', message: 'missing values' }, 400);
      }
      const values = body.values as CellValue[][];
      // Live finding (T18 live pass): the range write accepts STRING
      // values only — a non-string cell is rejected (`MissingString` for
      // numbers/booleans, a shape error for null). The connector coerces
      // before sending; the mock enforces the same contract.
      if (values.some((row) => row.some((cell) => typeof cell !== 'string'))) {
        return c.json({ code: 'MissingString', message: 'String is mandatory for this action.' }, 400);
      }
      // Documented contract: the values matrix must match the range's
      // shape (the docs: the matrix has one element per range row and one
      // value per range column). A mismatch is modeled as the documented
      // generic invalid-args error.
      const height = ref.rowEnd - ref.rowStart + 1;
      const width = ref.colEnd - ref.colStart + 1;
      if (values.length !== height || values.some((row) => row.length !== width)) {
        return c.json({ code: 'invalidRequest.inputArgs.invalid', message: 'values shape does not match the range' }, 400);
      }
      writeValues(sheet.values, ref, values);
      return c.json({ a1Notation: c.req.param('rangeAddress') });
    });

    // GET /v2.0/doc/me/export/task/query — poll an export task; the mock
    // completes instantly on first poll.
    this.app.get('/v2.0/doc/me/export/task/query', (c) => {
      const scripted = this.scriptedResponse();
      if (scripted) return scripted;
      const token = c.req.header('x-acs-dingtalk-access-token');
      if (!this.isAppAuthorized(token)) {
        return c.json(INVALID_AUTH, 401);
      }
      if (!c.req.query('operatorId')) {
        return c.json({ code: 'MissingoperatorId', message: 'operatorId is mandatory for this action.' }, 400);
      }
      const taskId = c.req.query('taskId');
      const job = taskId ? this.exportJobs.get(taskId) : undefined;
      if (!job) {
        return c.json({ code: 'ExportTaskNotFound', message: 'export task not found' }, 404);
      }
      const base = this.artifactBaseUrl ?? 'https://mock.dingtalk.example';
      return c.json({
        downloadUrl: `${base}/export/artifacts/${taskId}`,
        status: 'success',
      });
    });

    // POST /v1.0/robot/groupMessages/send — the robot group-send surface
    // (#49, official-docs shape; error codes PROVISIONAL until the live
    // pass pins them): app-token auth (no operatorId — the robot IS the
    // actor), body {msgKey, msgParam (a JSON string), openConversationId,
    // robotCode} → {processQueryKey, messageId}. The mock records each
    // accepted message so tests pin the connector's request shape.
    this.app.post('/v1.0/robot/groupMessages/send', async (c) => {
      const scripted = this.scriptedResponse();
      if (scripted) return scripted;
      if (!this.isAppAuthorized(c.req.header('x-acs-dingtalk-access-token'))) {
        return c.json(INVALID_AUTH, 401);
      }
      const body = await readJson(c);
      const openConversationId =
        isRecord(body) && typeof body.openConversationId === 'string'
          ? body.openConversationId
          : undefined;
      const robotCode =
        isRecord(body) && typeof body.robotCode === 'string' ? body.robotCode : undefined;
      const msgKey = isRecord(body) && typeof body.msgKey === 'string' ? body.msgKey : undefined;
      const msgParam =
        isRecord(body) && typeof body.msgParam === 'string' ? body.msgParam : undefined;
      if (!openConversationId || !robotCode || !msgKey || msgParam === undefined) {
        return c.json(
          { code: 'invalidRequestParam', message: 'openConversationId, robotCode, msgKey and msgParam are required' },
          400,
        );
      }
      const chat = this.chats.find((candidate) => candidate.openConversationId === openConversationId);
      if (!chat) {
        return c.json({ code: 'invalidConversationId', message: 'conversation not exists' }, 404);
      }
      // The robotCode must be the configured app robot's own code.
      if (this.options.robotCode === undefined || robotCode !== this.options.robotCode) {
        return c.json({ code: 'invalidRobotCode', message: 'the robot does not belong to this app' }, 403);
      }
      if (chat.robotInGroup === false) {
        return c.json(
          { code: 'Forbidden.RobotNotInGroup', message: 'robot is not in the group' },
          403,
        );
      }
      let content = '';
      try {
        const parsed: unknown = JSON.parse(msgParam);
        if (isRecord(parsed) && typeof parsed.content === 'string') content = parsed.content;
      } catch {
        // fall through: an unparsable msgParam is a param error
      }
      if (msgKey !== 'sampleText' || content === '') {
        return c.json(
          { code: 'invalidRequestParam', message: 'sampleText requires a msgParam {content}' },
          400,
        );
      }
      const messageId = `mid_${randomUUID()}`;
      this.sentGroupMessages.push({ openConversationId, robotCode, msgKey, content });
      return c.json({ processQueryKey: messageId, messageId });
    });
  }

  /** True when the presented token is a USER token this mock issued. */
  private isUserAuthorized(token: string | undefined): boolean {
    const record = token ? this.issuedAccessTokens.get(token) : undefined;
    return record !== undefined && Date.now() <= record.expiresAt;
  }

  /** True when the presented token is an APP token this mock issued. */
  private isAppAuthorized(token: string | undefined): boolean {
    const record = token ? this.issuedAppTokens.get(token) : undefined;
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

  /** Finds a seeded doc, failing when it lives outside the given space. */
  private findDocInSpace(docKey: string, spaceId: string): MockDingTalkDoc | undefined {
    const doc = this.docs.find((candidate) => candidate.docKey === docKey);
    if (!doc || (doc.spaceId ?? 'space-1') !== spaceId) return undefined;
    return doc;
  }

  /** All spaces the mock knows: seeded docs/folders + the mine workspace. */
  private knownSpaces(): Set<string> {
    const spaces = new Set<string>([MockDingTalkServer.MINE_SPACE_ID]);
    for (const doc of this.docs) spaces.add(doc.spaceId ?? 'space-1');
    for (const folder of this.folders) spaces.add(folder.spaceId);
    return spaces;
  }

  /** The wiki node shape served by GET /v2.0/wiki/nodes/{nodeId}. */
  private nodeShape(
    nodeId: string,
    name: string,
    type: 'FILE' | 'FOLDER',
    workspaceId: string,
    category: string,
    extension: string,
    creatorId: string,
    createdTimeMs = 1_700_000_000_000,
    updatedTimeMs = 1_700_000_000_000,
  ): {
    nodeId: string;
    workspaceId: string;
    name: string;
    type: string;
    category: string;
    extension: string;
    url: string;
    creatorId: string;
    modifierId: string;
    createTime: string;
    modifiedTime: string;
    createTimestamp: number;
    modifiedTimestamp: number;
    size: number;
    hasChildren: boolean;
  } {
    return {
      nodeId,
      workspaceId,
      name,
      type,
      category,
      extension,
      url: `https://alidocs.dingtalk.com/i/nodes/${nodeId}`,
      creatorId,
      modifierId: creatorId,
      createTime: new Date(createdTimeMs).toISOString(),
      modifiedTime: new Date(updatedTimeMs).toISOString(),
      createTimestamp: createdTimeMs,
      modifiedTimestamp: updatedTimeMs,
      size: 0,
      hasChildren: false,
    };
  }

  /** The search item shape (live-confirmed: no docKey/contentType). */
  private searchItemShape(doc: MockDingTalkDoc): {
    dentryUuid: string;
    name: string;
    path: Record<string, never>;
    creator: { name: string; userId: string };
    modifier: { name: string; userId: string };
  } {
    return {
      dentryUuid: doc.docKey,
      name: doc.name,
      path: {},
      creator: { name: 'Mock Owner', userId: 'mock-user-id' },
      modifier: { name: 'Mock Owner', userId: 'mock-user-id' },
    };
  }

  /** The doc_2.0 DentryVO shape served by create/rename/move. */
  private dentryVoShape(doc: MockDingTalkDoc): {
    dentryId: string;
    dentryUuid: string;
    docKey: string;
    name: string;
    contentType: string;
    extension: string;
    url: string;
    createdTime: number;
    updatedTime: number;
    spaceId: string;
    dentryType: string;
    hasChildren: boolean;
    creator: { unionId: string; name: string };
  } {
    return {
      dentryId: `dentry-${doc.docKey.slice(0, 16)}`,
      dentryUuid: doc.docKey,
      docKey: doc.docKey,
      // Live finding: the create response name carries the `.adoc`
      // extension; the connector strips it for the platform title.
      name: `${doc.name}.adoc`,
      contentType: 'alidoc',
      extension: 'adoc',
      url: `https://alidocs.dingtalk.com/i/doc/${doc.docKey}`,
      createdTime: doc.createdTime ?? 1_700_000_000_000,
      updatedTime: doc.updatedTime ?? 1_700_000_000_000,
      spaceId: `storage-${doc.spaceId ?? 'space-1'}`,
      dentryType: 'file',
      hasChildren: false,
      creator: { unionId: doc.ownerUnionId, name: 'Mock Owner' },
    };
  }

  /**
   * Derives the block list from stored markdown (live-confirmed block
   * shapes: paragraph{text}, heading{level: 'heading-N', text}). Blank
   * lines collapse into adjacent blocks upstream (the live read-back
   * showed no empty paragraphs between blocks), so they are skipped.
   */
  private blocksFromMarkdown(markdown: string): Array<Record<string, unknown>> {
    let index = 0;
    const blocks: Array<Record<string, unknown>> = [];
    for (const line of markdown.split('\n')) {
      if (line === '') continue;
      const heading = /^(#{1,6})\s+(.*)$/.exec(line);
      if (heading) {
        blocks.push({
          blockType: 'heading',
          index,
          id: `blk-${index}`,
          heading: { level: `heading-${heading[1]!.length}`, text: heading[2] },
        });
      } else {
        blocks.push({
          blockType: 'paragraph',
          index,
          id: `blk-${index}`,
          paragraph: { text: line },
        });
      }
      index++;
    }
    return blocks;
  }

  /** Seeds the mock's knowledge base with online documents (T17b). */
  seedDocs(docs: MockDingTalkDoc[]): void {
    this.docs.push(...docs);
  }

  /** Seeds folders (T17c live pass): targets for create-in-folder + move. */
  seedFolders(folders: MockDingTalkFolder[]): void {
    this.folders.push(...folders);
  }

  /** Seeds workbooks (T18a): the sheet surface's knowledge base. */
  seedWorkbooks(workbooks: MockDingTalkWorkbook[]): void {
    this.workbooks.push(...workbooks);
  }

  /** Seeds group chats (#49): the robot send surface's knowledge base. */
  seedChats(chats: MockDingTalkChat[]): void {
    this.chats.push(...chats);
  }

  /** Finds a seeded workbook by its dentryUuid (the opaque doc_id). */
  private findWorkbook(workbookId: string): MockDingTalkWorkbook | undefined {
    return this.workbooks.find((candidate) => candidate.workbookId === workbookId);
  }

  /**
   * Resolves the sheetId path slot: DingTalk accepts the sheet ID **or**
   * the NAME here (official-docs shape), so both match.
   */
  private findSheet(
    workbook: MockDingTalkWorkbook,
    sheetId: string,
  ): MockDingTalkSheet | undefined {
    return workbook.sheets.find(
      (candidate) => candidate.id === sheetId || candidate.name === sheetId,
    );
  }

  /** A fresh USER token pair, issued against the configured TTLs. */
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

  /** Scripts one failure for the next refresh_token, app-token or users/me call. */
  failNext(failure: ScriptedFailure): void {
    this.scriptedFailure = failure;
  }

  /**
   * Replaces an export artifact's bytes (#43): tests arm oversized
   * payloads (the connector's cap) or custom content types.
   */
  setExportArtifactBytes(jobId: string, bytes: Uint8Array, contentType: string): void {
    const job = this.exportJobs.get(jobId);
    if (job) {
      this.exportJobs.set(jobId, { ...job, bytes, contentType });
    }
  }

  /** Scripts one failure for the next content-insert call (create seed / append). */
  failNextInsert(failure: ScriptedFailure): void {
    this.insertFailure = failure;
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

/**
 * Live finding (T18 live pass): cells written as strings are parsed back
 * to native JSON types on read ('1' → 1, 'true' → true); other strings
 * and pre-seeded native values pass through unchanged.
 */
function parseCellValue(value: CellValue): CellValue {
  if (typeof value !== 'string') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  return value;
}
