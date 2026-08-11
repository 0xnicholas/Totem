import type { ActionContext, ActionHandler } from '../action.js';
import type {
  AppendDocContentInput,
  AppendDocContentOutput,
  CreateDocInput,
  CreateDocOutput,
  ExportDocInput,
  ExportDocOutput,
  GetDocContentInput,
  GetDocContentOutput,
  GetDocMetadataInput,
  GetDocMetadataOutput,
  MoveDocInput,
  MoveDocOutput,
  RenameDocInput,
  RenameDocOutput,
  SearchDocsInput,
  SearchDocsOutput,
  TestConnectionOutput,
} from '../actions.js';
import type { IConnector } from '../connector.js';
import { ActionError, errorMessage } from '../errors.js';
import { DingTalkApiError } from './oauth.js';

/**
 * Maps a DingTalk Open Platform API failure into the unified error
 * vocabulary (ADR-0005). The connector owns `not_found`, `rate_limited`
 * and `upstream_error`, and signals `auth_expired` when DingTalk rejects
 * the access token mid-call (refresh failures are caught earlier, in the
 * orchestration layer per ADR-0004). Everything else surfaces as
 * `upstream_error` with the original code preserved in `upstream` for
 * diagnostics — the vocabulary has no better fit.
 */
export function mapDingtalkError(err: DingTalkApiError): ActionError {
  if (err.httpStatus === 429) {
    return new ActionError('rate_limited', `DingTalk rate limited: ${err.message}`);
  }
  if (err.httpStatus === 401) {
    return new ActionError('auth_expired', `DingTalk rejected the access token: ${err.message}`);
  }
  if (err.httpStatus === 404) {
    return new ActionError('not_found', `DingTalk resource not found: ${err.message}`, {
      upstream: { code: err.code, message: err.message },
    });
  }
  return new ActionError('upstream_error', `DingTalk API error (${err.code}): ${err.message}`, {
    upstream: { code: err.code, message: err.message },
  });
}

/**
 * The real DingTalk Docs connector (T17a): a pure translator per ADR-0003 —
 * unified args → DingTalk request, DingTalk response → unified output,
 * DingTalk errors → the unified vocabulary. It receives an already-valid
 * user access token in `ActionContext.token` (ADR-0004) and never touches
 * the database, governance, or config stores.
 *
 * T17a shipped the connection skeleton: `test_connection`, which proves
 * the Connection's token against the cheapest call in DingTalk's proven
 * scope (the identity API `GET /v1.0/contact/users/me`, which needs only
 * the `openid` scope). T17b adds the read subset — `search_docs` (via
 * `POST /v2.0/storage/dentries/search`), `get_doc_content` and
 * `get_doc_metadata` (via the doc family `GET
 * /v1.0/doc/suites/documents/{docKey}[ /content]`) — over DingTalk's
 * online documents (ALIDOC). Sheets/workbooks stay out of the manifest
 * until a faithful translation lands (T17c decision point).
 *
 * T17c adds the write subset — `create_doc`, `append_doc_content`,
 * `rename_doc`, `move_doc` — modeled on the official docs/SDK: doc_2.0's
 * create/rename/move family under `POST /v2.0/doc/spaces/{spaceId}/dentries
 * [ /{dentryId}/rename|/move]` (space-scoped, so a node lookup
 * `GET /v2.0/wiki/nodes/{nodeId}` resolves the spaceId first), and the
 * markdown insert `POST /v1.0/doc/suites/documents/{docKey}/content`
 * (no path/index = append at the end of the document root). These write
 * APIs need `permission-Storage.File.Write`-family permission packages on
 * the DingTalk app (operator-side configuration; the OAuth scope string is
 * unchanged — live-pass item).
 *
 * Live-shape notes (T17b/T17c AC pending): the endpoints below are
 * modeled on the published API docs/SDK; the live pass with a real
 * DingTalk account corrects any drift (the Feishu connector's T9 pass
 * corrected several mock-modeled shapes).
 */
export class DingTalkConnector implements IConnector {
  readonly manifest = {
    id: 'dingtalk_docs',
    implements: [
      'test_connection',
      'search_docs',
      'get_doc_content',
      'get_doc_metadata',
      'create_doc',
      'append_doc_content',
      'rename_doc',
      'move_doc',
    ],
    // Conservative comfort level (120/min = 2 QPS average) until a live
    // pass confirms DingTalk's real per-API limits; the boundary throttles
    // per (tenant, connection) to this. T17c adds the write actions — the
    // same shared budget applies.
    rateLimit: { requestsPerMinute: 120 },
  };

  // T17c decision (recorded): export_doc stays OUT of the manifest until
  // the live pass confirms a faithful DingTalk export path. The async
  // task flow is confirmed from the official SDK — create
  // (`POST /v2.0/doc/dentries/export` {param: {dentryUuid, exportType}}),
  // poll (`GET /v2.0/doc/me/export/task/query?operatorId=&taskId=` →
  // {downloadUrl, status}) — but the exportType enum values are
  // unconfirmed (only `dingTalksheetToxlsx` is published), so the mapping
  // below is an assumption and nothing has run live. The translation is
  // implemented and Seam B tested so the live pass can flip the manifest
  // entry after correcting the mapping.
  private static readonly EXPORT_TYPE_BY_FORMAT: Record<string, string> = {
    // Pattern modeled on the published `dingTalksheetToxlsx` example —
    // UNCONFIRMED until the live pass.
    docx: 'dingTalkDocToDocx',
    pdf: 'dingTalkDocToPdf',
  };

  private readonly handlers: Record<string, ActionHandler>;
  private readonly exportPollMs: number;
  private readonly exportMaxAttempts: number;
  /**
   * DingTalk's v2.0 doc APIs require the acting user's `unionId` as
   * `operatorId`. The unionId is stable per connection and resolvable from
   * the identity API, so the connector caches it in memory per connection
   * (translation-layer state only — ADR-0003's no-storage rule is about
   * the database, governance, and config stores). A rejected token drops
   * the cache entry (docRequest), so a re-authorized connection
   * re-resolves instead of acting with a stale operatorId.
   */
  private readonly unionIds = new Map<string, string>();

  /** The platform doc-type for an online DingTalk document (category ALIDOC). */
  private static readonly DOC_TYPE_ONLINE_DOC = 'docx';

  constructor(
    private readonly apiBaseUrl: string,
    options: { exportPollMs?: number; exportMaxAttempts?: number } = {},
  ) {
    this.exportPollMs = options.exportPollMs ?? 2000;
    this.exportMaxAttempts = options.exportMaxAttempts ?? 60;
    this.handlers = {
      test_connection: async (_args, ctx) => {
        // The cheapest call in the connector's proven scope: the identity
        // API succeeds iff the connection's user access token is valid and
        // API access works. The token manager has already refreshed an
        // expiring token (ADR-0004), so this call is the live proof.
        await dingtalkRequest(this.apiBaseUrl, '/v1.0/contact/users/me', {
          token: ctx.token,
        });
        const output: TestConnectionOutput = {
          connection_id: ctx.connectionId,
          status: 'ok',
        };
        return output;
      },

      search_docs: async (args: SearchDocsInput, ctx) => {
        const input = args;
        const response = await this.docRequest<DentriesResponse>(
          '/v2.0/storage/dentries/search',
          {
            method: 'POST',
            body: () => ({
              keyword: input.query,
              option: { maxResults: input.limit ?? 50 },
            }),
          },
          ctx,
        );
        // v1 read scope: online documents (ALIDOC) only — the platform's
        // doc actions address documents, not the broader file store (which
        // the search API also returns: uploaded files, images, archives).
        // Matches beyond DingTalk's page cap (maxResults ≤ 50) are
        // truncated; cursor semantics are v2 per ADR-0012.
        const output: SearchDocsOutput = {
          data: response.dentries
            .filter((dentry) => dentry.contentType === 'alidoc')
            .map((dentry) => ({
              doc_id: dentry.docKey,
              title: dentry.name,
              doc_type: DingTalkConnector.DOC_TYPE_ONLINE_DOC,
            })),
          next: null,
        };
        return output;
      },

      get_doc_content: async (args: GetDocContentInput, ctx) => {
        const input = args;
        const response = await this.docRequest<{ content: string }>(
          `/v1.0/doc/suites/documents/${encodeURIComponent(input.doc_id)}/content`,
          {},
          ctx,
        );
        const output: GetDocContentOutput = {
          doc_id: input.doc_id,
          content: response.content,
        };
        return output;
      },

      get_doc_metadata: async (args: GetDocMetadataInput, ctx) => {
        const input = args;
        const response = await this.docRequest<DentryResponse>(
          `/v1.0/doc/suites/documents/${encodeURIComponent(input.doc_id)}`,
          {},
          ctx,
        );
        const output: GetDocMetadataOutput = {
          doc_id: input.doc_id,
          title: response.name,
          owner_id: response.creator.unionId,
          doc_type: DingTalkConnector.DOC_TYPE_ONLINE_DOC,
          // DingTalk timestamps are epoch-millisecond Longs (occasionally
          // serialized as strings); the platform contract promises an ISO
          // timestamp.
          edited_at: toIsoMillis(response.updatedTime),
        };
        return output;
      },

      create_doc: async (args: CreateDocInput, ctx) => {
        const input = args;
        // Target space: an explicit folder (its nodeId IS its dentryUuid,
        // which the create API takes as parentDentryId) or the acting
        // user's "我的文档" root.
        const spaceId =
          input.folder_id !== undefined && input.folder_id !== null
            ? (await this.resolveNode(input.folder_id, ctx)).workspaceId
            : await this.mineWorkspaceId(ctx);
        const created = await this.docRequest<DentryVO>(
          `/v2.0/doc/spaces/${encodeURIComponent(spaceId)}/dentries`,
          {
            method: 'POST',
            // The doc_2.0 create API takes operatorId in the BODY (the
            // other doc APIs take it as a query param) — SDK-confirmed.
            body: (operatorId: string) => ({
              dentryType: 'file',
              // 0 = online document (ALIDOC); T17c modeled shape.
              documentType: 0,
              name: input.title,
              operatorId,
              ...(input.folder_id !== undefined && input.folder_id !== null
                ? { parentDentryId: input.folder_id }
                : {}),
            }),
          },
          ctx,
        );
        const docId = created.docKey ?? created.dentryUuid;
        if (!docId) {
          throw new ActionError(
            'upstream_error',
            'DingTalk create-document response omitted docKey and dentryUuid',
          );
        }
        // DingTalk creates documents empty; seeded initial content goes
        // through the same insert path as append_doc_content (Feishu
        // precedent). If seeding fails the document exists upstream — the
        // error message says so, so the agent does not blindly retry the
        // create.
        if (input.content !== undefined && input.content !== '') {
          try {
            await this.insertContent(docId, input.content, ctx);
          } catch (err) {
            throw new ActionError(
              'upstream_error',
              `Document "${docId}" was created but its initial content failed to append: ${errorMessage(err)}`,
            );
          }
        }
        const output: CreateDocOutput = {
          doc_id: docId,
          title: created.name,
        };
        return output;
      },

      append_doc_content: async (args: AppendDocContentInput, ctx) => {
        const input = args;
        await this.insertContent(input.doc_id, input.content, ctx);
        // The AC promises the updated state: re-read the full content
        // (Feishu precedent). The append itself has landed by now, so a
        // re-read failure says so — a retry would duplicate the append.
        let content: string;
        try {
          content = (
            await this.docRequest<{ content: string }>(
              `/v1.0/doc/suites/documents/${encodeURIComponent(input.doc_id)}/content`,
              {},
              ctx,
            )
          ).content;
        } catch (err) {
          throw new ActionError(
            'upstream_error',
            `Content was appended to "${input.doc_id}" but re-reading it failed: ${errorMessage(err)}`,
          );
        }
        const output: AppendDocContentOutput = {
          doc_id: input.doc_id,
          content,
        };
        return output;
      },

      rename_doc: async (args: RenameDocInput, ctx) => {
        const input = args;
        // The rename endpoint is space-scoped (dentryUuid ids, doc_2.0):
        // resolve the doc's space first.
        const node = await this.resolveNode(input.doc_id, ctx);
        const response = await this.docRequest<DentryVO>(
          `/v2.0/doc/spaces/${encodeURIComponent(node.workspaceId)}/dentries/${encodeURIComponent(input.doc_id)}/rename`,
          { method: 'POST', body: () => ({ name: input.new_title }) },
          ctx,
        );
        const output: RenameDocOutput = {
          doc_id: input.doc_id,
          title: response.name,
        };
        return output;
      },

      move_doc: async (args: MoveDocInput, ctx) => {
        const input = args;
        // The move endpoint is space-scoped on both ends: resolve the
        // source doc's space (path) and the target folder's space (body).
        const source = await this.resolveNode(input.doc_id, ctx);
        const target = await this.resolveNode(input.folder_id, ctx);
        await this.docRequest<DentryVO>(
          `/v2.0/doc/spaces/${encodeURIComponent(source.workspaceId)}/dentries/${encodeURIComponent(input.doc_id)}/move`,
          {
            method: 'POST',
            body: () => ({
              targetSpaceId: target.workspaceId,
              toParentDentryId: input.folder_id,
            }),
          },
          ctx,
        );
        const output: MoveDocOutput = {
          doc_id: input.doc_id,
          folder_id: input.folder_id,
        };
        return output;
      },

      export_doc: async (args: ExportDocInput, ctx) => {
        const input = args;
        // Hidden from the manifest (T17c decision above); implemented so
        // the live pass can flip it. DingTalk exports are async, like
        // Feishu: create a task, then poll until the downloadUrl exists.
        // Note: the SDK's export-create takes no operatorId — docRequest
        // attaches it as a query param anyway (harmless if ignored
        // upstream; verify live).
        const task = await this.docRequest<ExportTaskState>(
          '/v2.0/doc/dentries/export',
          {
            method: 'POST',
            body: () => ({
              param: {
                dentryUuid: input.doc_id,
                exportType: DingTalkConnector.EXPORT_TYPE_BY_FORMAT[input.format],
              },
            }),
          },
          ctx,
        );
        const exported = await this.pollExport(task.jobId, ctx);
        const output: ExportDocOutput = {
          doc_id: input.doc_id,
          format: input.format,
          // The job id is the only artifact reference the flow yields; the
          // downloadUrl is the artifact itself.
          artifact_id: task.jobId,
          url: exported.downloadUrl,
        };
        return output;
      },
    };
  }

  /**
   * One doc-family call with the acting user's `operatorId` attached.
   * The doc APIs take it as a query param; the doc_2.0 create API takes it
   * in the BODY instead (SDK-confirmed shape), so `body` is built from
   * the resolved operatorId (static bodies ignore it).
   * A rejected token drops the cached unionId (the connection's identity
   * may have changed on re-authorization) and rethrows, so the caller
   * sees `auth_expired` (the token manager marks the connection and
   * fail-fast afterwards).
   */
  private async docRequest<T>(
    path: string,
    opts: {
      method?: 'GET' | 'POST';
      body?: (operatorId: string) => unknown;
      query?: Record<string, string>;
    },
    ctx: ActionContext,
  ): Promise<T> {
    const operatorId = await this.resolveUnionId(ctx.connectionId, ctx.token);
    try {
      return await dingtalkRequest<T>(this.apiBaseUrl, path, {
        method: opts.method,
        token: ctx.token,
        query: { operatorId, ...opts.query },
        body: opts.body?.(operatorId),
      });
    } catch (err) {
      if (err instanceof ActionError && err.code === 'auth_expired') {
        this.unionIds.delete(ctx.connectionId);
      }
      throw err;
    }
  }

  /** Resolves a node's wiki info (its spaceId) by dentryUuid. */
  private async resolveNode(
    nodeId: string,
    ctx: ActionContext,
  ): Promise<{ workspaceId: string }> {
    const response = await this.docRequest<{ node: { workspaceId: string } }>(
      `/v2.0/wiki/nodes/${encodeURIComponent(nodeId)}`,
      {},
      ctx,
    );
    return response.node;
  }

  /** The acting user's "我的文档" space id (create without a folder). */
  private async mineWorkspaceId(ctx: ActionContext): Promise<string> {
    const response = await this.docRequest<{ workspace: { workspaceId: string } }>(
      '/v2.0/wiki/mineWorkspaces',
      {},
      ctx,
    );
    return response.workspace.workspaceId;
  }

  /** Appends markdown at the end of a document's root (no path/index). */
  private async insertContent(docId: string, markdown: string, ctx: ActionContext): Promise<void> {
    await this.docRequest<{ success: boolean }>(
      `/v1.0/doc/suites/documents/${encodeURIComponent(docId)}/content`,
      {
        method: 'POST',
        body: () => ({ content: { content: markdown, type: 'markdown' } }),
      },
      ctx,
    );
  }

  /** Polls an async export task until the downloadUrl exists (Feishu pattern). */
  private async pollExport(
    taskId: string,
    ctx: ActionContext,
  ): Promise<{ downloadUrl: string }> {
    for (let attempt = 0; attempt < this.exportMaxAttempts; attempt++) {
      const poll = await this.docRequest<ExportTaskState>(
        '/v2.0/doc/me/export/task/query',
        { query: { taskId } },
        ctx,
      );
      if (poll.downloadUrl) {
        return { downloadUrl: poll.downloadUrl };
      }
      if (poll.status === 'failed') {
        throw new ActionError('upstream_error', `DingTalk export task "${taskId}" failed`, {
          upstream: { code: 'export_failed', message: poll.status },
        });
      }
      if (attempt < this.exportMaxAttempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, this.exportPollMs));
      }
    }
    throw new ActionError('upstream_error', `DingTalk export task "${taskId}" did not complete`);
  }

  /**
   * Resolves the acting user's unionId (DingTalk's `operatorId`), cached
   * per connection. The identity call only runs on a cache miss.
   */
  private async resolveUnionId(connectionId: string, token: string | undefined): Promise<string> {
    const cached = this.unionIds.get(connectionId);
    if (cached) return cached;
    const me = await dingtalkRequest<{ unionId: string }>(
      this.apiBaseUrl,
      '/v1.0/contact/users/me',
      { token },
    );
    this.unionIds.set(connectionId, me.unionId);
    return me.unionId;
  }

  execute(action: string, args: unknown, ctx: ActionContext): Promise<unknown> {
    const handler = this.handlers[action];
    if (!handler) {
      // Unreachable through the executor (implements check); defensive for
      // direct misuse. A plain error becomes upstream_error at Seam A.
      return Promise.reject(new Error(`Action "${action}" is not implemented by dingtalk_docs`));
    }
    return Promise.resolve(handler(args, ctx));
  }
}

/** A dentry in a search response / doc-info response (T17b modeled shapes). */
interface DentryResponse {
  dentryId: string;
  docKey: string;
  name: string;
  contentType: string;
  url: string;
  createdTime: number | string;
  updatedTime: number | string;
  creator: { unionId: string; name: string };
}

/** A dentry in a doc_2.0 create/rename/move response (T17c modeled shape). */
interface DentryVO {
  dentryUuid?: string;
  docKey?: string;
  name: string;
}

/** The async export task state (T17c modeled shape). */
interface ExportTaskState {
  jobId: string;
  status: string;
  downloadUrl?: string;
}

/**
 * Normalizes an epoch-millisecond Long (number or numeric string) to ISO.
 * A missing or non-numeric value is an upstream contract break — the
 * platform output schema requires edited_at — so it fails loudly as an
 * upstream_error instead of a raw RangeError.
 */
function toIsoMillis(value: number | string | undefined): string {
  const millis = typeof value === 'string' ? Number(value) : value;
  if (millis === undefined || !Number.isFinite(millis)) {
    throw new ActionError(
      'upstream_error',
      `DingTalk document info omitted a valid updatedTime (got ${String(value)})`,
    );
  }
  return new Date(millis).toISOString();
}

interface DentriesResponse {
  dentries: DentryResponse[];
  nextToken: string;
}

/**
 * One DingTalk Open Platform API call: `x-acs-dingtalk-access-token` auth,
 * JSON body parsing, and vocabulary mapping of every failure. Network and
 * non-JSON failures are upstream errors — DingTalk told us nothing.
 */
async function dingtalkRequest<T>(
  baseUrl: string,
  path: string,
  opts: { method?: 'GET' | 'POST'; token?: string; query?: Record<string, string>; body?: unknown },
): Promise<T> {
  const url = new URL(`${baseUrl}${path}`);
  for (const [key, value] of Object.entries(opts.query ?? {})) {
    url.searchParams.set(key, value);
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method: opts.method ?? 'GET',
      headers: {
        'x-acs-dingtalk-access-token': opts.token ?? '',
        ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
  } catch (err) {
    throw new ActionError(
      'upstream_error',
      `DingTalk API unreachable: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let body: unknown;
  let rawBody = '';
  try {
    rawBody = await response.text();
    body = rawBody === '' ? undefined : JSON.parse(rawBody);
  } catch {
    throw new ActionError(
      'upstream_error',
      `DingTalk API returned non-JSON (HTTP ${response.status})`,
    );
  }

  if (!response.ok) {
    const errorBody = (body ?? {}) as { code?: string; message?: string };
    throw mapDingtalkError(
      new DingTalkApiError(
        errorBody.code ?? 'UnknownError',
        errorBody.message ?? `DingTalk API error (HTTP ${response.status})`,
        response.status,
        false,
      ),
    );
  }
  return body as T;
}
