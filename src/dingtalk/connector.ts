import type { ActionContext, ActionHandler } from '../action.js';
import type {
  AppendDocContentInput,
  AppendDocContentOutput,
  CellValue,
  CreateDocInput,
  CreateDocOutput,
  ExportDocInput,
  ExportDocOutput,
  GetDocContentInput,
  GetDocContentOutput,
  GetDocMetadataInput,
  GetDocMetadataOutput,
  GetExportArtifactInput,
  GetExportArtifactOutput,
  MoveDocInput,
  MoveDocOutput,
  ReadSheetCellsInput,
  ReadSheetCellsOutput,
  RenameDocInput,
  RenameDocOutput,
  SearchDocsInput,
  SearchDocsOutput,
  SendMessageInput,
  SendMessageOutput,
  TestConnectionOutput,
  WriteSheetCellsInput,
  WriteSheetCellsOutput,
} from '../actions.js';
import type { IConnector } from '../connector.js';
import { GET_EXPORT_ARTIFACT_MAX_BYTES, toArtifactOutput } from '../actions.js';
import { ActionError, errorMessage } from '../errors.js';
import { DingTalkApiError } from './oauth.js';
import { createUpstreamHttp, type UpstreamHttp } from '../upstream-http.js';

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
 * DingTalk errors → the unified vocabulary. It receives already-valid
 * tokens from the orchestration layer and never touches the database,
 * governance, or config stores.
 *
 * Token model (T17 LIVE PASS, corrected from the mock-modeled shape):
 * DingTalk's doc/wiki/storage APIs authenticate with the APP-level access
 * token (client credentials, `POST /v1.0/oauth2/accessToken`) plus the
 * acting user's `operatorId` (unionId); the USER access token only serves
 * the identity APIs (`users/me`). Accordingly:
 * - `ActionContext.token` (the user token) is used for identity:
 *   `test_connection` and the unionId resolution;
 * - the APP token comes from the injected `getAppAccessToken` resolver
 *   (composition root, wired to the DingTalk token manager's
 *   client-credentials lifecycle — ADR-0004 holds: connectors never do
 *   OAuth, they receive valid tokens).
 *
 * Live-confirmed endpoint shapes (T17 live pass; the mock tracks them):
 * - search: `POST /v2.0/storage/dentries/search` → `{items, nextToken}`,
 *   items carry `dentryUuid` + `name` and NO contentType/docKey;
 * - metadata + space resolution: `GET /v2.0/wiki/nodes/{nodeId}` → node
 *   with ISO `modifiedTime`, numeric `creatorId`, `workspaceId`;
 * - content read: `GET /v1.0/doc/suites/documents/{docId}/blocks` →
 *   blocks (paragraph/heading), which the connector renders to markdown;
 * - content write: `POST /v1.0/doc/suites/documents/{docId}/content`
 *   (markdown, no path/index = append at the end);
 * - create: `POST /v2.0/doc/spaces/{spaceId}/dentries` with `operatorId`
 *   in the BODY and `parentDentryId` = the folder's storage dentryId
 *   (resolved via `GET /v2.0/doc/dentries/{uuid}/queryDentryId`);
 * - rename/move: `POST /v2.0/doc/spaces/{spaceId}/dentries/{dentryUuid}
 *   /rename|move` (move's `toParentDentryId` takes the dentryUuid).
 *
 * Workbook surface (T18a, official-docs shapes — same app-token +
 * operatorId auth model; workbookId = the dentryUuid node id):
 * - sheet resolution: `GET /v1.0/doc/workbooks/{workbookId}/sheets` →
 *   `{value: [{id, name}]}` (worksheet display order — the first entry
 *   is the default target when sheet_name is omitted; live-pass item);
 * - range read: `GET /v1.0/doc/workbooks/{workbookId}/sheets/{sheetId}
 *   /ranges/{rangeAddress}?select=values&operatorId=` → `{values:
 *   any[][]}` — the sheetId slot accepts the sheet ID **or** the NAME
 *   directly, so an explicit sheet_name passes through without
 *   resolution (live-confirmed path shape);
 * - range write: `PUT .../ranges/{rangeAddress}?operatorId=` body
 *   `{values}` → `{a1Notation}` — DingTalk returns NO cell count, so
 *   updated_cells is computed as rows × columns of the submitted values
 *   (recorded finding).
 *
 * export_doc was hidden from the manifest from T17c until #43 (2026-08-14
 * gap-review decision) flipped it visible: the translation had been
 * implemented and Seam B tested all along; the flip is Minor per ADR-0014.
 * Live caveat (T17 pass, still true): the async export endpoints 404 for
 * this app (`InvalidAction.NotFound`) and the `Document.Document.Read`
 * permission point is not grantable in the DingTalk console — a live call
 * surfaces that upstream failure to the agent instead of hiding the
 * capability. The exportType mapping below remains an unconfirmed
 * assumption (patterned on the published `dingTalksheetToxlsx` example).
 *
 * Messaging surface (#49, second ADR-0016 batch — chat path only):
 * `POST /v1.0/robot/groupMessages/send` with `{msgKey: "sampleText",
 * msgParam: <JSON string>, openConversationId, robotCode}` under the APP
 * token — no operatorId: the app robot IS the actor (no per-user sending
 * API exists; the canonical description says "identity of this
 * connection", ADR-0016 amendment). The robotCode is the app robot's
 * console value, resolved per tenant from the credentials synced via the
 * admin API. `email` addressing fails `validation_error` BEFORE any
 * upstream call: DingTalk exposes no email→userid lookup API, so the
 * canonical input cannot be honored here — the ADR-0014 §4 input rule
 * (consumption standard §11.4; a provider that cannot honor a canonical
 * optional input fails loudly, never silently). chat_id = openConversationId
 * of a group the app created
 * or learned via message events, with the robot as a member — the same
 * app-created universe as WeCom. The exact group-not-found /
 * robot-not-in-group upstream codes are provisional until the live pass
 * pins them; mapDingTalkError owns the mapping either way.
 */
export class DingTalkConnector implements IConnector {
  readonly manifest = {
    id: 'dingtalk_docs',
    provider: 'dingtalk' as const,
    implements: [
      'test_connection',
      'search_docs',
      'get_doc_content',
      'get_doc_metadata',
      'create_doc',
      'append_doc_content',
      'rename_doc',
      'move_doc',
      'export_doc',
      'get_export_artifact',
      'read_sheet_cells',
      'write_sheet_cells',
      // Chat path only (#49): the messaging send joins the manifest — the
      // robot group-send API, no per-user addressing on this provider.
      'send_message',
    ],
    // Conservative comfort level (120/min = 2 QPS average) until the live
    // pass measures DingTalk's real per-API limits; the boundary throttles
    // per (tenant, connection) to this. Writes share the same budget.
    rateLimit: { requestsPerMinute: 120 },
  };

  private readonly handlers: Record<string, ActionHandler>;
  private readonly exportPollMs: number;
  private readonly exportMaxAttempts: number;
  private readonly request: UpstreamHttp;
  private readonly getAppAccessToken: ((tenantId: string) => Promise<string>) | undefined;
  /**
   * The app robot's console robotCode per tenant (#49) — resolved by the
   * composition root from the credentials synced via the admin API. A
   * tenant without one simply cannot send messages (the handler fails
   * loudly with an actionable error).
   */
  private readonly getRobotCode: ((tenantId: string) => Promise<string | undefined>) | undefined;
  /**
   * DingTalk's doc APIs require the acting user's `unionId` as
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
    options: {
      getAppAccessToken?: (tenantId: string) => Promise<string>;
      getRobotCode?: (tenantId: string) => Promise<string | undefined>;
      exportPollMs?: number;
      exportMaxAttempts?: number;
    } = {},
  ) {
    this.getAppAccessToken = options.getAppAccessToken;
    this.getRobotCode = options.getRobotCode;
    this.exportPollMs = options.exportPollMs ?? 2000;
    this.exportMaxAttempts = options.exportMaxAttempts ?? 60;

    // The Upstream HTTP Kernel (CONTEXT.md): the shared request stack, with
    // DingTalk's envelope convention (the HTTP status is the failure signal;
    // empty 2xx bodies are valid payloads) as this profile's handleResponse.
    this.request = createUpstreamHttp({
      baseUrl: apiBaseUrl,
      label: 'DingTalk API',
      authHeaderName: 'x-acs-dingtalk-access-token',
      allowEmptyBody: true,
      handleResponse: (response, body) => {
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
        return body;
      },
    });

    this.handlers = {
      test_connection: async (_args, ctx) => {
        // The cheapest call in the connector's proven scope: the identity
        // API succeeds iff the connection's user access token is valid and
        // API access works. The token manager has already refreshed an
        // expiring token (ADR-0004), so this call is the live proof. (The
        // app token is derived from tenant credentials, not the user grant;
        // a broken app secret surfaces on the first doc action instead.)
        await this.request( '/v1.0/contact/users/me', {
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
        // ADR-0014 §4: this provider cannot honor the canonical cursor
        // input (the DingTalk cursor request path is not live-verified),
        // and silently ignoring it is forbidden — fail validation loudly.
        // The output side mirrors the stance: next stays null (a provider
        // without cursor support yields a single page by contract), so a
        // conforming caller never has a cursor to pass back.
        if (input.page_token !== undefined) {
          throw new ActionError(
            'validation_error',
            'search_docs on DingTalk does not support pagination: this connector returns a single page and never emits a next cursor',
          );
        }
        const response = await this.docRequest<SearchResponse>(
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
        // Live finding (T17 live pass): search returns `{items, nextToken}`
        // — items carry `dentryUuid` + `name` and NO contentType/docKey,
        // so the T17b-modeled ALIDOC filter cannot be applied (the search
        // response does not say what the dentry is). Matches beyond
        // DingTalk's page cap (maxResults ≤ 50) are truncated. #42 landed
        // real cursors on the canonical `next` (Feishu connectors); the
        // DingTalk cursor request path is not live-verified, so this
        // connector still returns next: null — a provider without cursor
        // support yields a single page by contract.
        const output: SearchDocsOutput = {
          data: response.items.map((item) => ({
            doc_id: item.dentryUuid,
            title: item.name,
            doc_type: DingTalkConnector.DOC_TYPE_ONLINE_DOC,
          })),
          next: null,
        };
        return output;
      },

      get_doc_content: async (args: GetDocContentInput, ctx) => {
        const input = args;
        // Live-confirmed read path: the block API (the v1.0 doc-family GET
        // endpoints modeled in T17b do not exist live; the v2.0 content
        // endpoints need a permission point this app cannot grant). The
        // official DingTalk MCP reads content the same way — blocks →
        // markdown.
        const response = await this.docRequest<BlocksResponse>(
          `/v1.0/doc/suites/documents/${encodeURIComponent(input.doc_id)}/blocks`,
          {},
          ctx,
        );
        const output: GetDocContentOutput = {
          doc_id: input.doc_id,
          content: blocksToMarkdown(response.result.data),
        };
        return output;
      },

      get_doc_metadata: async (args: GetDocMetadataInput, ctx) => {
        const input = args;
        const response = await this.docRequest<NodeResponse>(
          `/v2.0/wiki/nodes/${encodeURIComponent(input.doc_id)}`,
          {},
          ctx,
        );
        const output: GetDocMetadataOutput = {
          doc_id: input.doc_id,
          // Live finding: the node name carries the `.adoc` extension
          // (like the create response); the platform title is the bare
          // name.
          title: stripAdocExtension(response.node.name),
          // Live finding: the node creatorId is the numeric userId (not the
          // unionId) — opaque either way per the platform contract.
          owner_id: response.node.creatorId,
          doc_type: DingTalkConnector.DOC_TYPE_ONLINE_DOC,
          // Live finding: node timestamps are ISO strings — no Long
          // conversion (the T17b-modeled epoch-ms shape did not hold).
          edited_at: response.node.modifiedTime,
        };
        return output;
      },

      create_doc: async (args: CreateDocInput, ctx) => {
        const input = args;
        // #64 coverage gap (ADR-0014 §4 input rule, the #49 email
        // precedent): the doc API creates online documents only
        // (documentType 0) — there is no verified sheet-creation path, so
        // doc_type "sheet" fails validation_error BEFORE any upstream
        // call: never silently ignore a canonical input this provider
        // cannot honor. Agents create documents (omit doc_type) here.
        if (input.doc_type === 'sheet') {
          throw new ActionError(
            'validation_error',
            'DingTalk create_doc cannot create sheets (doc_type "sheet" is unsupported here): the doc API creates online documents only. Omit doc_type to create a document',
          );
        }
        // Target space: an explicit folder (its nodeId IS its dentryUuid)
        // or the acting user's "我的文档" root. Live finding: the create
        // API's parentDentryId takes the folder's STORAGE dentryId, not
        // the dentryUuid — resolved via queryDentryId (move_doc's
        // toParentDentryId takes the dentryUuid instead; the API is
        // internally inconsistent).
        let spaceId: string;
        let parentDentryId: string | undefined;
        if (input.folder_id !== undefined && input.folder_id !== null) {
          spaceId = (await this.resolveNode(input.folder_id, ctx)).workspaceId;
          parentDentryId = (
            await this.docRequest<{ dentryId: string }>(
              `/v2.0/doc/dentries/${encodeURIComponent(input.folder_id)}/queryDentryId`,
              {},
              ctx,
            )
          ).dentryId;
        } else {
          spaceId = await this.mineWorkspaceId(ctx);
        }
        const created = await this.docRequest<DentryVO>(
          `/v2.0/doc/spaces/${encodeURIComponent(spaceId)}/dentries`,
          {
            method: 'POST',
            // The doc_2.0 create API takes operatorId in the BODY (the
            // other doc APIs take it as a query param) — live-confirmed.
            body: (operatorId) => ({
              dentryType: 'file',
              // 0 = online document (ALIDOC); live-confirmed.
              documentType: 0,
              name: input.title,
              operatorId,
              ...(parentDentryId !== undefined ? { parentDentryId } : {}),
            }),
          },
          ctx,
        );
        const docId = created.dentryUuid ?? created.docKey;
        if (!docId) {
          throw new ActionError(
            'upstream_error',
            'DingTalk create-document response omitted dentryUuid and docKey',
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
          // Live finding: the create response echoes the name with the
          // `.adoc` extension; the platform title is the bare name.
          title: stripAdocExtension(created.name),
        };
        return output;
      },

      append_doc_content: async (args: AppendDocContentInput, ctx) => {
        const input = args;
        await this.insertContent(input.doc_id, input.content, ctx);
        // The AC promises the updated state: re-read the full content
        // through the blocks path (Feishu precedent). The append itself
        // has landed by now, so a re-read failure says so — a retry would
        // duplicate the append.
        let content: string;
        try {
          const response = await this.docRequest<BlocksResponse>(
            `/v1.0/doc/suites/documents/${encodeURIComponent(input.doc_id)}/blocks`,
            {},
            ctx,
          );
          content = blocksToMarkdown(response.result.data);
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
          title: stripAdocExtension(response.name),
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
            // Live finding: unlike rename (query param accepted), the move
            // API REQUIRES operatorId in the BODY — query-only calls fail
            // with MissingoperatorId.
            body: (operatorId) => ({
              operatorId,
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
        // Visible since #43 (Minor per ADR-0014; live caveat in the class
        // comment). DingTalk exports are async: create a task, then poll
        // until the downloadUrl exists. Note: the SDK's export-create takes
        // no operatorId — docRequest attaches it as a query param anyway
        // (harmless if ignored).
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

      get_export_artifact: async (args: GetExportArtifactInput, ctx) => {
        const input = args;
        // The artifact id is the export job's id: re-poll the task for its
        // (short-lived) presigned downloadUrl, then fetch it. Presigned
        // URLs are absolute and carry their authorization in the URL — the
        // kernel fetches them verbatim, with no auth header attached.
        const exported = await this.pollExport(input.artifact_id, ctx);
        const file = await this.request.download(exported.downloadUrl, {
          maxBytes: GET_EXPORT_ARTIFACT_MAX_BYTES,
        });
        const output: GetExportArtifactOutput = toArtifactOutput(input.artifact_id, file);
        return output;
      },

      read_sheet_cells: async (args: ReadSheetCellsInput, ctx) => {
        const input = args;
        // Explicit sheet_name passes straight into the sheetId path slot
        // (DingTalk accepts the sheet NAME there — no id resolution); an
        // omitted sheet_name resolves the first worksheet.
        const sheetId = await this.resolveSheetId(input.doc_id, input.sheet_name, ctx);
        const response = await this.docRequest<WorkbookRangeReadResponse>(
          `/v1.0/doc/workbooks/${encodeURIComponent(input.doc_id)}` +
            `/sheets/${encodeURIComponent(sheetId)}/ranges/${encodeURIComponent(input.range)}`,
          // select=values limits the response to the cell values (the
          // docs recommend it for performance); the platform contract
          // preserves the native JSON cell types.
          { query: { select: 'values' } },
          ctx,
        );
        const output: ReadSheetCellsOutput = {
          doc_id: input.doc_id,
          range: input.range,
          data: response.values,
          // A single range is a single page — no cursor applies.
          next: null,
        };
        return output;
      },

      write_sheet_cells: async (args: WriteSheetCellsInput, ctx) => {
        const input = args;
        const sheetId = await this.resolveSheetId(input.doc_id, input.sheet_name, ctx);
        await this.docRequest<WorkbookRangeWriteResponse>(
          `/v1.0/doc/workbooks/${encodeURIComponent(input.doc_id)}` +
            `/sheets/${encodeURIComponent(sheetId)}/ranges/${encodeURIComponent(input.range)}`,
          {
            method: 'PUT',
            // Live finding (T18 live pass): the range write accepts STRING
            // values only — numbers/booleans are rejected with
            // `MissingString` and null with a shape error. The platform
            // values are coerced to their string form; the read-back
            // parses numeric/boolean strings back to native types.
            body: () => ({
              values: input.values.map((row) =>
                row.map((cell) => (cell === null ? '' : String(cell))),
              ),
            }),
          },
          ctx,
        );
        const output: WriteSheetCellsOutput = {
          doc_id: input.doc_id,
          range: input.range,
          // Recorded finding (T18a): DingTalk's range write returns only
          // the a1Notation — no cell count — so updated_cells is computed
          // as rows × columns of the submitted values (the documented
          // contract requires the matrix to match the range's shape, so
          // this equals the range's cell count on success).
          updated_cells: input.values.reduce((sum, row) => sum + row.length, 0),
        };
        return output;
      },

      send_message: async (args: SendMessageInput, ctx) => {
        const input = args;
        // #59: markdown is not implemented on DingTalk messaging — reject
        // loudly BEFORE any upstream call (§11.4 input rule, the same
        // posture as the email rejection below), never silently degrade to
        // text; the agent can resend without `format`.
        if (input.format === 'markdown') {
          throw new ActionError(
            'validation_error',
            'send_message on DingTalk does not implement format=markdown yet — ' +
              'resend without `format` to send plain text.',
          );
        }
        // #61: DingTalk @-addressing is mobile-number based — email→mobile
        // lookup (or explicit rejection) is its own batch's question. Reject
        // loudly BEFORE any upstream call (§11.4 input rule), never silently
        // drop the mentions.
        if (input.mentions !== undefined && input.mentions.length > 0) {
          throw new ActionError(
            'validation_error',
            'send_message on DingTalk does not implement mentions yet — ' +
              'resend without `mentions`.',
          );
        }
        // ADR-0014 §4 input rule (first live case; consumption standard
        // §11.4): DingTalk exposes no email→userid lookup API, so the
        // canonical email input cannot be honored — fail validation loudly
        // BEFORE any upstream call, never silently ignore the parameter.
        if (input.email !== undefined) {
          throw new ActionError(
            'validation_error',
            'send_message on DingTalk cannot address a user by email: the platform has no email→userid lookup API. ' +
              'Address a chat by chat_id instead (a group the app created, with the robot as a member).',
          );
        }
        const robotCode = await this.resolveRobotCode(ctx.tenantId);
        const response = await this.robotRequest<GroupMessageSendResponse>(
          '/v1.0/robot/groupMessages/send',
          {
            method: 'POST',
            body: {
              msgParam: JSON.stringify({ content: input.content }),
              msgKey: 'sampleText',
              openConversationId: input.chat_id,
              robotCode,
            },
          },
          ctx,
        );
        if (!response.messageId) {
          throw new ActionError(
            'upstream_error',
            'DingTalk send-message response omitted messageId',
          );
        }
        const output: SendMessageOutput = { message_id: response.messageId };
        return output;
      },
    };
  }

  // The exportType mapping is an unconfirmed assumption (patterned on
  // the published `dingTalksheetToxlsx` example); export_doc is visible
  // since #43 with this caveat recorded in the class comment.
  private static readonly EXPORT_TYPE_BY_FORMAT: Record<string, string> = {
    docx: 'dingTalkDocToDocx',
    pdf: 'dingTalkDocToPdf',
  };

  /**
   * One doc-family call with the acting user's `operatorId` attached and
   * the APP token in the auth header (live-confirmed auth model). The doc
   * APIs take operatorId as a query param; the doc_2.0 create API takes it
   * in the BODY instead, so `body` is built from the resolved operatorId
   * (static bodies ignore it).
   *
   * A rejected APP token mid-call is an operator-config problem (rotated
   * secret, revoked app), NOT a dead user grant: it is reclassified from
   * `auth_expired` to `upstream_error` so the agent does not re-authorize
   * the connection. The unionId cache is dropped either way (the identity
   * context may have changed; it re-resolves on the next call).
   */
  private async docRequest<T>(
    path: string,
    opts: {
      method?: 'GET' | 'POST' | 'PUT';
      body?: (operatorId: string) => unknown;
      query?: Record<string, string>;
    },
    ctx: ActionContext,
  ): Promise<T> {
    const operatorId = await this.resolveUnionId(ctx.connectionId, ctx.token);
    const appToken = await this.appToken(ctx.tenantId);
    try {
      return await this.request<T>( path, {
        method: opts.method,
        token: appToken,
        query: { operatorId, ...opts.query },
        body: opts.body?.(operatorId),
      });
    } catch (err) {
      if (err instanceof ActionError && err.code === 'auth_expired') {
        this.unionIds.delete(ctx.connectionId);
        throw reclassifiedAppTokenRejection(err);
      }
      throw err;
    }
  }

  /**
   * One APP-token call with NO acting user (#49): the robot messaging
   * APIs speak for the app itself, so there is no operatorId and no
   * unionId context. App-token rejection is reclassified exactly like
   * docRequest's (operator-config problem, not the connection grant).
   */
  private async robotRequest<T>(
    path: string,
    opts: { method?: 'POST'; body?: unknown },
    ctx: ActionContext,
  ): Promise<T> {
    const appToken = await this.appToken(ctx.tenantId);
    try {
      return await this.request<T>(path, { method: opts.method, token: appToken, body: opts.body });
    } catch (err) {
      if (err instanceof ActionError && err.code === 'auth_expired') {
        throw reclassifiedAppTokenRejection(err);
      }
      throw err;
    }
  }

  /**
   * The app robot's console robotCode (#49): resolved per tenant by the
   * composition root from the synced credentials. A tenant without one
   * cannot use send_message — fail loudly with the operator action, not a
   * silent skip (an operator-config gap, so upstream_error like the
   * missing app-token provider, not a validation problem of the args).
   */
  private async resolveRobotCode(tenantId: string): Promise<string> {
    if (!this.getRobotCode) {
      throw new ActionError(
        'upstream_error',
        'DingTalk connector has no robotCode provider configured (composition root)',
      );
    }
    const robotCode = await this.getRobotCode(tenantId);
    if (robotCode === undefined || robotCode === '') {
      throw new ActionError(
        'upstream_error',
        `Tenant "${tenantId}" has no DingTalk robotCode synced — ` +
          'send_message needs the app robot\u2019s code; sync it via the admin API ' +
          '(POST /admin/tenants/<tenantId>/dingtalk-creds with robotCode)',
      );
    }
    return robotCode;
  }

  /** The app-level token, resolved by the composition-root provider. */
  private appToken(tenantId: string): Promise<string> {
    if (!this.getAppAccessToken) {
      return Promise.reject(
        new ActionError(
          'upstream_error',
          'DingTalk connector has no app-token provider configured (composition root)',
        ),
      );
    }
    return this.getAppAccessToken(tenantId);
  }

  /**
   * Resolves the sheet slot for the workbook range APIs. An explicit
   * sheet_name is passed through UNCHANGED: DingTalk's sheetId path slot
   * accepts the sheet NAME directly (live-confirmed path shape — no id
   * resolution). When omitted, the first worksheet is resolved via the
   * sheets list ({value: [{id, name}]}, display order).
   */
  private async resolveSheetId(
    workbookId: string,
    sheetName: string | undefined,
    ctx: ActionContext,
  ): Promise<string> {
    if (sheetName !== undefined) {
      return sheetName;
    }
    const response = await this.docRequest<WorkbookSheetsResponse>(
      `/v1.0/doc/workbooks/${encodeURIComponent(workbookId)}/sheets`,
      {},
      ctx,
    );
    const first = response.value[0];
    if (!first) {
      throw new ActionError('upstream_error', `Workbook "${workbookId}" has no sheets`);
    }
    return first.id;
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
   * per connection. The identity call only runs on a cache miss and uses
   * the USER token (the identity API rejects the app token — live pass).
   */
  private async resolveUnionId(connectionId: string, token: string | undefined): Promise<string> {
    const cached = this.unionIds.get(connectionId);
    if (cached) return cached;
    const me = await this.request<{ unionId: string }>(
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

/** The robot group-send response (official-docs shape; messageId is the platform's message_id). */
interface GroupMessageSendResponse {
  processQueryKey?: string;
  messageId?: string;
}

/**
 * A rejected APP token is an operator-config problem (rotated secret,
 * revoked app), NOT a dead user grant: the reclassification keeps the
 * agent from re-authorizing the connection for an app-level issue. One
 * policy shared by every app-token call (doc family, #49 robot send).
 */
function reclassifiedAppTokenRejection(err: ActionError): ActionError {
  return new ActionError(
    'upstream_error',
    `DingTalk rejected the app token (operator-config issue, not the connection grant): ${err.message}`,
    { upstream: err.upstream },
  );
}

/** A dentry in a doc_2.0 create/rename/move response (live-confirmed shape). */
interface DentryVO {
  dentryUuid?: string;
  docKey?: string;
  name: string;
}

/** The search response (live-confirmed: items, no dentries/contentType). */
interface SearchResponse {
  items: Array<{
    dentryUuid: string;
    name: string;
    creator?: { userId?: string };
    modifier?: { userId?: string };
  }>;
  nextToken: string;
}

/** The wiki node response (live-confirmed shape). */
interface NodeResponse {
  node: {
    workspaceId: string;
    name: string;
    creatorId: string;
    modifiedTime: string;
    type: string;
    category: string;
    extension: string;
  };
}

/** A document block as the block API returns it (live-confirmed shapes). */
interface Block {
  blockType: string;
  index: number;
  id: string;
  paragraph?: { text: string };
  heading?: { level: string; text: string };
}

/** The block-list response (live-confirmed wrapper). */
interface BlocksResponse {
  result: { data: Block[] };
}

/** The async export task state (T17c modeled shape). */
interface ExportTaskState {
  jobId: string;
  status: string;
  downloadUrl?: string;
}

/** The worksheet-list response (T18a, official-docs shape). */
interface WorkbookSheetsResponse {
  value: Array<{ id: string; name: string }>;
}

/** The range-read response with select=values (T18a, official-docs shape). */
interface WorkbookRangeReadResponse {
  values: CellValue[][];
}

/** The range-write response (T18a, official-docs shape): a1Notation only. */
interface WorkbookRangeWriteResponse {
  a1Notation: string;
}

/**
 * Renders the block list as markdown-ish plain text — the platform
 * contract ("plain text with markdown-style headings preserved").
 * Live-confirmed block shapes are `paragraph{text}` and `heading{level:
 * 'heading-N', text}`; other block types (tables, callouts, …) carry their
 * own payloads and are dropped in v1 (empty paragraphs included).
 */
function blocksToMarkdown(blocks: Block[]): string {
  return blocks
    .map((block) => {
      if (block.blockType === 'heading' && block.heading) {
        const level = Number(/heading-(\d)/.exec(block.heading.level)?.[1] ?? 1);
        return `${'#'.repeat(level)} ${block.heading.text}`;
      }
      if (block.blockType === 'paragraph' && block.paragraph) {
        return block.paragraph.text;
      }
      return '';
    })
    .filter((line) => line !== '')
    .join('\n');
}

/**
 * Live finding: create/rename echo the title with the `.adoc` extension;
 * the platform title is the bare name (the official DingTalk MCP strips
 * file suffixes from names too).
 */
function stripAdocExtension(name: string): string {
  return name.endsWith('.adoc') ? name.slice(0, -'.adoc'.length) : name;
}

