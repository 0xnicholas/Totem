import type { ActionContext, ActionHandler } from '../action.js';
import type {
  AppendDocContentInput,
  AppendDocContentOutput,
  CreateDocInput,
  CreateDocOutput,
  DeleteBitableRecordsInput,
  DeleteBitableRecordsOutput,
  DeleteDocInput,
  DeleteDocOutput,
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
  ReadBitableRecordsInput,
  ReadBitableRecordsOutput,
  ReadSheetCellsInput,
  ReadSheetCellsOutput,
  RenameDocInput,
  RenameDocOutput,
  SearchDocsInput,
  SearchDocsOutput,
  SendMessageInput,
  SendMessageOutput,
  UpdateBitableRecordsInput,
  UpdateBitableRecordsOutput,
  WriteBitableRecordsInput,
  WriteBitableRecordsOutput,
  WriteSheetCellsInput,
  WriteSheetCellsOutput,
} from '../actions.js';
import type { IConnector } from '../connector.js';
import { GET_EXPORT_ARTIFACT_MAX_BYTES, toArtifactOutput } from '../actions.js';
import { ActionError, errorMessage } from '../errors.js';
import { FeishuApiError } from './oauth.js';
import {
  createUpstreamHttp,
  type UpstreamHttp,
  type UpstreamRequest,
  type UpstreamRequestOptions,
} from '../upstream-http.js';

/**
 * Feishu error-code families (T7, live-verified in the T9 demo pass):
 * 10662 document-not-found, 91402 sheets NOTEXIST, 90215 unknown sheetId,
 * 99991668/99991672 invalid access token, 99991400 rate limit.
 */
const NOT_FOUND_CODES = new Set([10662, 91402, 90215]);
const TOKEN_REJECTED_CODES = new Set([99991668, 99991672]);
const RATE_LIMIT_CODES = new Set([99991400]);

/**
 * Maps a Feishu Docs API failure into the unified error vocabulary
 * (ADR-0005). The connector owns `not_found`, `rate_limited` and
 * `upstream_error`, and signals `auth_expired` when Feishu rejects the
 * access token mid-call (refresh failures are caught earlier, in the
 * orchestration layer per ADR-0004). Permission failures and everything
 * else surface as `upstream_error` with the original code preserved in
 * `upstream` for diagnostics — the vocabulary has no better fit.
 */
export function mapFeishuError(err: FeishuApiError): ActionError {
  // Rate limits arrive as HTTP 429 and sometimes as a 200 envelope with
  // the rate-limit code; both map to rate_limited.
  if (err.httpStatus === 429 || RATE_LIMIT_CODES.has(err.code)) {
    return new ActionError('rate_limited', `Feishu rate limited: ${err.message}`);
  }
  if (TOKEN_REJECTED_CODES.has(err.code)) {
    return new ActionError('auth_expired', `Feishu rejected the access token: ${err.message}`);
  }
  if (NOT_FOUND_CODES.has(err.code)) {
    return new ActionError('not_found', `Document not found: ${err.message}`, {
      upstream: { code: String(err.code), message: err.message },
    });
  }
  return new ActionError('upstream_error', `Feishu Docs API error (${err.code}): ${err.message}`, {
    upstream: { code: String(err.code), message: err.message },
  });
}

/**
 * The real Feishu Docs connector (T7): a pure translator per ADR-0003 —
 * unified args → Feishu request, Feishu response → unified output, Feishu
 * errors → the unified vocabulary. It receives an already-valid access
 * token in `ActionContext.token` (ADR-0004) and never touches the
 * database, governance, or config stores.
 */
export interface FeishuConnectorOptions {
  /** Delay between export-task polls, in ms (tests pass 0). */
  exportPollMs?: number;
  /** Max export-task polls before failing. */
  exportMaxAttempts?: number;
  /** Delay between move-task polls, in ms (tests pass 0). */
  movePollMs?: number;
  /** Max move-task polls before failing. */
  moveMaxAttempts?: number;
}

export class FeishuConnector implements IConnector {
  readonly manifest = {
    id: 'feishu_docs',
    provider: 'feishu' as const,
    implements: [
      'test_connection',
      'create_doc',
      'search_docs',
      'get_doc_content',
      'get_doc_metadata',
      'append_doc_content',
      'rename_doc',
      'move_doc',
      'delete_doc',
      'export_doc',
      'get_export_artifact',
      'read_sheet_cells',
      'write_sheet_cells',
      'feishu_read_bitable_records',
      'feishu_write_bitable_records',
      'feishu_update_bitable_records',
      'feishu_delete_bitable_records',
      'send_message',
    ],
  };

  /**
   * One Feishu request: the kernel call with the DocsEnvelope return type
   * bound (the envelope is Feishu's response shape — handlers read `.data`).
   */
  private docsRequest<T>(path: string, opts: UpstreamRequestOptions): Promise<DocsEnvelope<T>> {
    return this.request<DocsEnvelope<T>>(path, opts);
  }

  private readonly handlers: Record<string, ActionHandler>;
  private readonly exportPollMs: number;
  private readonly exportMaxAttempts: number;
  private readonly movePollMs: number;
  private readonly moveMaxAttempts: number;
  private readonly request: UpstreamHttp;

  constructor(
    private readonly baseUrl: string,
    options: FeishuConnectorOptions = {},
  ) {
    // Live note (T9 demo pass): real export jobs took 40-60s in the live
    // walk, so the default budget is 2 minutes (60 polls × 2s).
    this.exportPollMs = options.exportPollMs ?? 2000;
    this.exportMaxAttempts = options.exportMaxAttempts ?? 60;
    // Move tasks are fast (single file, no rendering): a small budget —
    // 10 polls × 500ms — is enough and fails fast when Feishu stalls.
    this.movePollMs = options.movePollMs ?? 500;
    this.moveMaxAttempts = options.moveMaxAttempts ?? 10;

    // The Upstream HTTP Kernel (CONTEXT.md): the shared request stack, with
    // Feishu's envelope convention (HTTP 200 with code !== 0 is the failure
    // signal — not the HTTP status) as this profile's handleResponse.
    this.request = createUpstreamHttp({
      baseUrl,
      label: 'Feishu Docs API',
      authHeaderName: 'authorization',
      tokenPrefix: 'Bearer ',
      allowEmptyBody: false,
      handleResponse: (response, body) => {
        const envelope = (body ?? {}) as DocsEnvelope<never>;
        if (envelope.code !== 0) {
          throw mapFeishuError(
            new FeishuApiError(
              envelope.code ?? 0,
              envelope.msg ?? `Feishu Docs API error (HTTP ${response.status})`,
              response.status,
              false,
            ),
          );
        }
        return envelope;
      },
    });
    this.handlers = {
      test_connection: async (_args, ctx) => {
        // The cheapest call in the connector's proven scope (drive:drive
        // readonly is part of the v1 authorize set): a page_size=1 files
        // list succeeds iff the connection's access token is valid and
        // API access works. The token manager has already refreshed an
        // expiring token (ADR-0004), so this call is the live proof.
        await this.docsRequest<FilesListData>( '/open-apis/drive/v1/files', {
          token: ctx.token,
          query: { page_size: '1' },
        });
        return { connection_id: ctx.connectionId, status: 'ok' };
      },

      search_docs: async (args: SearchDocsInput, ctx) => {
        const input = args;
        const response = await this.docsRequest<SearchFilesData & Paginated>(
          '/open-apis/drive/v1/files/search',
          {
            method: 'POST',
            token: ctx.token,
            query: {
              page_size: String(input.limit ?? 50),
              // #42: the cursor is opaque to the agent — the connector is
              // the only side that parses Feishu's pagination markers.
              ...(input.page_token !== undefined ? { page_token: input.page_token } : {}),
            },
            body: { search_key: input.query },
          },
        );
        const output: SearchDocsOutput = {
          // Live shape (T9 demo pass): data.docs_entities with docs_token /
          // docs_type — not the files/token/type shape the mock modelled.
          data: response.data.docs_entities.map((file) => ({
            doc_id: file.docs_token,
            title: file.title,
            doc_type: file.docs_type,
          })),
          // #42: a real cursor when Feishu says more pages exist.
          next: nextCursor(response.data),
        };
        return output;
      },

      get_doc_content: async (args: GetDocContentInput, ctx) => {
        const input = args;
        const response = await this.docsRequest<RawContentData>(
          `/open-apis/docx/v1/documents/${encodeURIComponent(input.doc_id)}/raw_content`,
          { token: ctx.token },
        );
        const output: GetDocContentOutput = {
          doc_id: input.doc_id,
          content: response.data.content,
        };
        return output;
      },

      create_doc: async (args: CreateDocInput, ctx) => {
        const input = args;
        const response = await this.docsRequest<CreateDocData>(
          '/open-apis/docx/v1/documents',
          {
            method: 'POST',
            token: ctx.token,
            body: {
              title: input.title,
              // folder_id is nullable in the schema; null means "no folder"
              // and must not be sent as folder_token: null.
              ...(input.folder_id !== undefined && input.folder_id !== null
                ? { folder_token: input.folder_id }
                : {}),
            },
          },
        );
        const docId = response.data.document.document_id;
        // Feishu creates documents empty; seeded initial content goes
        // through the same blocks-append path as append_doc_content. If
        // seeding fails the document exists upstream — the error message
        // says so, so the agent does not blindly retry the create.
        if (input.content !== undefined && input.content !== '') {
          try {
            await appendBlocks(this.request, docId, input.content, ctx.token);
          } catch (err) {
            throw new ActionError(
              'upstream_error',
              `Document "${docId}" was created but its initial content failed to append: ${errorMessage(err)}`,
            );
          }
        }
        // Live shape (T9 demo pass): the create API returns document_id +
        // title only — no URL.
        const output: CreateDocOutput = {
          doc_id: docId,
          title: response.data.document.title,
        };
        return output;
      },

      append_doc_content: async (args: AppendDocContentInput, ctx) => {
        const input = args;
        await appendBlocks(this.request, input.doc_id, input.content, ctx.token);
        // The AC promises the updated state: re-read the full content. The
        // append itself has landed by now, so a re-read failure says so —
        // a retry would duplicate the append.
        let content: RawContentData;
        try {
          content = (
            await this.docsRequest<RawContentData>(
              `/open-apis/docx/v1/documents/${encodeURIComponent(input.doc_id)}/raw_content`,
              { token: ctx.token },
            )
          ).data;
        } catch (err) {
          throw new ActionError(
            'upstream_error',
            `Content was appended to "${input.doc_id}" but re-reading it failed: ${errorMessage(err)}`,
          );
        }
        const output: AppendDocContentOutput = {
          doc_id: input.doc_id,
          content: content.content,
        };
        return output;
      },

      rename_doc: async (args: RenameDocInput, ctx) => {
        const input = args;
        // Live finding (T9 demo pass): Feishu has NO document-title API —
        // PATCH /docx/v1/documents/{id} with a title returns 1770001. The
        // title is the root Page block's text, so renaming patches the root
        // block (block_id == document_id) with update_text_elements.
        // #41: update_text_elements REPLACES the elements with what is
        // sent — sending one run wipes the rest of the title's formatting.
        // Read the root block's current elements, replace only the first
        // run's text, and send the full array back.
        const current = await this.docsRequest<UpdateBlockData>(
          `/open-apis/docx/v1/documents/${encodeURIComponent(input.doc_id)}/blocks/${encodeURIComponent(input.doc_id)}`,
          { token: ctx.token },
        );
        const elements = current.data.block.page?.elements ?? [];
        const updated =
          elements[0]?.text_run !== undefined
            ? elements.map((element, index) =>
                index === 0
                  ? { ...element, text_run: { ...element.text_run!, content: input.new_title } }
                  : element,
              )
            : [{ text_run: { content: input.new_title } }];
        const response = await this.docsRequest<UpdateBlockData>(
          `/open-apis/docx/v1/documents/${encodeURIComponent(input.doc_id)}/blocks/${encodeURIComponent(input.doc_id)}`,
          {
            method: 'PATCH',
            token: ctx.token,
            body: {
              update_text_elements: {
                elements: updated,
              },
            },
          },
        );
        const title = extractPageTitle(response.data.block);
        const output: RenameDocOutput = { doc_id: input.doc_id, title };
        return output;
      },

      move_doc: async (args: MoveDocInput, ctx) => {
        const input = args;
        // The move call's type must match the file's real type (mismatch →
        // params error), so probe it first: opaque ID semantics — only the
        // connector parses IDs, the agent stays zero-burden (#41).
        const meta = await resolveDocMeta(this.request, input.doc_id, ctx.token);
        // Feishu's move is async: it returns a task id that is verified
        // below; the platform contract confirms the target folder, which
        // is all the agent needs.
        const task = await this.docsRequest<MoveTaskData>(
          `/open-apis/drive/v1/files/${encodeURIComponent(input.doc_id)}/move`,
          {
            method: 'POST',
            token: ctx.token,
            body: { folder_token: input.folder_id, type: meta.doc_type },
          },
        );
        // task_id is returned for async moves; when the response carries
        // one, the move is not confirmed until the task succeeds.
        if (task.data.task_id) {
          await this.pollDriveTask(task.data.task_id, ctx.token, 'move');
        }
        const output: MoveDocOutput = { doc_id: input.doc_id, folder_id: input.folder_id };
        return output;
      },

      delete_doc: async (args: DeleteDocInput, ctx) => {
        const input = args;
        // The delete API needs the file's real type (like move/export), so
        // probe it: opaque ID semantics — the agent stays zero-burden.
        // Feishu moves deleted files to the system trash; the platform
        // class still reads destructive (irreversible from the agent's
        // world, ADR-0018) and the action description says so.
        const meta = await resolveDocMeta(this.request, input.doc_id, ctx.token);
        const task = await this.docsRequest<DeleteTaskData>(
          `/open-apis/drive/v1/files/${encodeURIComponent(input.doc_id)}`,
          {
            method: 'DELETE',
            token: ctx.token,
            query: { type: meta.doc_type },
          },
        );
        // Doc-verified: deletes are async like moves — a task_id in the
        // response is verified through the shared task_check endpoint.
        if (task.data.task_id) {
          await this.pollDriveTask(task.data.task_id, ctx.token, 'delete');
        }
        const output: DeleteDocOutput = { doc_id: input.doc_id };
        return output;
      },

      export_doc: async (args: ExportDocInput, ctx) => {
        const input = args;
        // Feishu exports are async: create a task, then poll the ticket
        // until the exported drive file exists.
        const task = await this.docsRequest<ExportTaskData>(
          '/open-apis/drive/v1/export_tasks',
          {
            method: 'POST',
            token: ctx.token,
            // Live finding (T9 demo pass): the export task requires the
            // SOURCE type (type) — without it Feishu returns 99992402. The
            // type is the file's real type, probed per #41 (a mismatched
            // type fails like a missing one).
            body: {
              type: (await resolveDocMeta(this.request, input.doc_id, ctx.token)).doc_type,
              file_extension: input.format,
              token: input.doc_id,
            },
          },
        );
        const exported = await this.pollExport(task.data.ticket, input.doc_id, ctx.token);
        const output: ExportDocOutput = {
          doc_id: input.doc_id,
          format: input.format,
          artifact_id: exported.file_token,
          // The artifact lives in the user's drive; fetching it requires
          // the connection's Feishu authorization.
          url: `${this.baseUrl}/open-apis/drive/v1/medias/${encodeURIComponent(exported.file_token)}/download`,
        };
        return output;
      },

      get_export_artifact: async (args: GetExportArtifactInput, ctx) => {
        const input = args;
        // #43: the platform holds the authorization the agent lacks — the
        // medias download fetched here is exactly what export_doc's URL
        // points at, with the connection's token attached. The kernel's
        // cap guard rejects oversized artifacts before bytes surface.
        const file = await this.request.download(
          `/open-apis/drive/v1/medias/${encodeURIComponent(input.artifact_id)}/download`,
          { token: ctx.token, maxBytes: GET_EXPORT_ARTIFACT_MAX_BYTES },
        );
        const output: GetExportArtifactOutput = toArtifactOutput(input.artifact_id, file);
        return output;
      },

      read_sheet_cells: async (args: ReadSheetCellsInput, ctx) => {
        const input = args;
        const sheetId = await resolveSheetId(this.request, input.doc_id, input.sheet_name, ctx.token);
        const range = `${sheetId}!${input.range}`;
        const response = await this.docsRequest<SheetReadData>(
          `/open-apis/sheets/v2/spreadsheets/${encodeURIComponent(input.doc_id)}/values/${encodeURIComponent(range)}`,
          { token: ctx.token },
        );
        const output: ReadSheetCellsOutput = {
          doc_id: input.doc_id,
          range: input.range,
          data: response.data.valueRange.values,
          next: null,
        };
        return output;
      },

      write_sheet_cells: async (args: WriteSheetCellsInput, ctx) => {
        const input = args;
        const sheetId = await resolveSheetId(this.request, input.doc_id, input.sheet_name, ctx.token);
        const range = `${sheetId}!${input.range}`;
        const response = await this.docsRequest<SheetWriteData>(
          `/open-apis/sheets/v2/spreadsheets/${encodeURIComponent(input.doc_id)}/values`,
          {
            method: 'PUT',
            token: ctx.token,
            body: { valueRange: { range, values: input.values } },
          },
        );
        const output: WriteSheetCellsOutput = {
          doc_id: input.doc_id,
          range: input.range,
          updated_cells: response.data.updatedCells,
        };
        return output;
      },

      feishu_read_bitable_records: async (args: ReadBitableRecordsInput, ctx) => {
        const input = args;
        const tableId = await resolveBitableTable(this.request, input.doc_id, input.table_name, ctx.token);
        const response = await this.docsRequest<BitableRecordsData & Paginated>(
          `/open-apis/bitable/v1/apps/${encodeURIComponent(input.doc_id)}/tables/${encodeURIComponent(tableId)}/records`,
          {
            token: ctx.token,
            query: {
              page_size: String(input.limit ?? 100),
              ...(input.page_token !== undefined ? { page_token: input.page_token } : {}),
            },
          },
        );
        const output: ReadBitableRecordsOutput = {
          doc_id: input.doc_id,
          table_name: input.table_name,
          data: response.data.items.map((record) => ({
            record_id: record.record_id,
            fields: record.fields,
          })),
          // #42: a real cursor when Feishu says more pages exist.
          next: nextCursor(response.data),
        };
        return output;
      },

      feishu_write_bitable_records: async (args: WriteBitableRecordsInput, ctx) => {
        const input = args;
        const tableId = await resolveBitableTable(this.request, input.doc_id, input.table_name, ctx.token);
        const response = await this.docsRequest<BitableCreateData>(
          `/open-apis/bitable/v1/apps/${encodeURIComponent(input.doc_id)}/tables/${encodeURIComponent(tableId)}/records`,
          {
            method: 'POST',
            token: ctx.token,
            body: { fields: input.fields },
          },
        );
        const output: WriteBitableRecordsOutput = {
          doc_id: input.doc_id,
          table_name: input.table_name,
          record_id: response.data.record.record_id,
        };
        return output;
      },

      feishu_update_bitable_records: async (args: UpdateBitableRecordsInput, ctx) => {
        const input = args;
        const tableId = await resolveBitableTable(this.request, input.doc_id, input.table_name, ctx.token);
        const response = await this.docsRequest<BitableUpdateData>(
          `/open-apis/bitable/v1/apps/${encodeURIComponent(input.doc_id)}/tables/${encodeURIComponent(tableId)}/records/${encodeURIComponent(input.record_id)}`,
          {
            method: 'PUT',
            token: ctx.token,
            body: { fields: input.fields },
          },
        );
        const output: UpdateBitableRecordsOutput = {
          doc_id: input.doc_id,
          table_name: input.table_name,
          record_id: response.data.record.record_id,
          fields: response.data.record.fields,
        };
        return output;
      },

      feishu_delete_bitable_records: async (args: DeleteBitableRecordsInput, ctx) => {
        const input = args;
        const tableId = await resolveBitableTable(this.request, input.doc_id, input.table_name, ctx.token);
        // Doc-verified: batch_delete takes a plain array of record ids
        // (≤500, schema-capped), succeeds as a unit, and returns no count —
        // deleted_count is the batch size the upstream call accepted.
        await this.docsRequest<Record<never, never>>(
          `/open-apis/bitable/v1/apps/${encodeURIComponent(input.doc_id)}/tables/${encodeURIComponent(tableId)}/records/batch_delete`,
          {
            method: 'POST',
            token: ctx.token,
            body: { records: input.record_ids },
          },
        );
        const output: DeleteBitableRecordsOutput = {
          doc_id: input.doc_id,
          table_name: input.table_name,
          deleted_count: input.record_ids.length,
        };
        return output;
      },

      get_doc_metadata: async (args: GetDocMetadataInput, ctx) => {
        const input = args;
        // The opaque doc_id carries no type, and the metas API needs the
        // type it is asked about — so the connector probes for it (#41).
        // The successful probe IS the metadata; no second call is made.
        const meta = await resolveDocMeta(this.request, input.doc_id, ctx.token);
        const output: GetDocMetadataOutput = {
          doc_id: meta.doc_token,
          title: meta.title,
          owner_id: meta.owner_id,
          doc_type: meta.doc_type,
          // Live shape (T9 demo pass): latest_modify_time is a unix-second
          // string; the platform contract promises an ISO timestamp.
          edited_at: toIsoTimestamp(meta.latest_modify_time),
        };
        return output;
      },

      send_message: async (args: SendMessageInput, ctx) => {
        const input = args;
        // ADR-0016: the connection owner's identity (user access token),
        // natural-key email addressing or the opaque chat_id — never
        // provider tokens (open_id/user_id/union_id). Exactly-one-of is
        // schema-enforced upstream of the handler.
        const receiveIdType = input.email !== undefined ? 'email' : 'chat_id';
        const receiveId = input.email ?? input.chat_id!;
        const response = await this.request<DocsEnvelope<SendMessageData>>(
          '/open-apis/im/v1/messages',
          {
            method: 'POST',
            token: ctx.token,
            query: { receive_id_type: receiveIdType },
            body: {
              receive_id: receiveId,
              msg_type: 'text',
              // Feishu encodes per-msg_type content as a JSON string.
              content: JSON.stringify({ text: input.content }),
            },
          },
        );
        // Live-note (deferred): IM-specific not_found codes (unknown email /
        // chat) surface as upstream_error until a live pass pins them — the
        // generic envelope mapping below covers everything else already.
        return { message_id: response.data.message_id } satisfies SendMessageOutput;
      },
    };
  }

  /**
   * Polls an export task ticket until it completes (job_status 0), fails
   * (job_status 2), or the attempt budget runs out.
   */
  private async pollExport(
    ticket: string,
    docId: string,
    token: string | undefined,
  ): Promise<{ file_token: string }> {
    for (let attempt = 0; attempt < this.exportMaxAttempts; attempt++) {
      // Live finding (T9 demo pass): the poll endpoint requires the source
      // document's token as a query parameter (99992402 without it).
      const poll = await this.docsRequest<ExportPollData>(
        `/open-apis/drive/v1/export_tasks/${encodeURIComponent(ticket)}`,
        { token, query: { token: docId } },
      );
      // Live shape (T9 demo pass): a COMPLETED task drops job_status from
      // the response entirely — only result.file_token remains — so the
      // presence of the artifact IS the completion signal.
      if (poll.data.result?.file_token) {
        return poll.data.result;
      }
      if (poll.data.job_status === 2) {
        throw new ActionError(
          'upstream_error',
          `Feishu export task "${ticket}" failed: ${poll.data.msg ?? 'unknown reason'}`,
          { upstream: { code: 'export_failed', message: poll.data.msg ?? '' } },
        );
      }
      if (attempt < this.exportMaxAttempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, this.exportPollMs));
      }
    }
    throw new ActionError('upstream_error', `Feishu export task "${ticket}" did not complete`);
  }

  /**
   * Verifies a drive async task (#41, #44): moves and deletes return a
   * task_id polled via task_check until the string status settles.
   * Mirrors pollExport with the move budget (drive tasks are fast).
   */
  private async pollDriveTask(
    taskId: string,
    token: string | undefined,
    label: string,
  ): Promise<void> {
    for (let attempt = 0; attempt < this.moveMaxAttempts; attempt++) {
      const poll = await this.docsRequest<MoveTaskCheckData>(
        '/open-apis/drive/v1/files/task_check',
        { token, query: { task_id: taskId } },
      );
      if (poll.data.status === 'success') return;
      if (poll.data.status === 'fail') {
        throw new ActionError(
          'upstream_error',
          `Feishu ${label} task "${taskId}" failed`,
          { upstream: { code: `${label}_failed`, message: `task ${taskId} failed` } },
        );
      }
      if (attempt < this.moveMaxAttempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, this.movePollMs));
      }
    }
    throw new ActionError('upstream_error', `Feishu ${label} task "${taskId}" did not complete`);
  }

  execute(action: string, args: unknown, ctx: ActionContext): Promise<unknown> {
    const handler = this.handlers[action];
    if (!handler) {
      // Unreachable through the executor (implements check); defensive for
      // direct misuse. A plain error becomes upstream_error at Seam A.
      return Promise.reject(new Error(`Action "${action}" is not implemented by feishu_docs`));
    }
    return Promise.resolve(handler(args, ctx));
  }
}

interface DocsEnvelope<T> {
  code: number;
  msg?: string;
  data: T;
}

interface CreateDocData {
  document: { document_id: string; title: string };
}

interface BlocksData {
  items: Array<{ block_id: string; block_type: number; parent_id: string | null }>;
}

interface UpdateBlockData {
  block: {
    block_id: string;
    page?: { elements: Array<{ text_run?: { content?: string; text_element_style?: unknown } }> };
  };
}

interface ExportTaskData {
  ticket: string;
}

interface MoveTaskData {
  task_id?: string;
}

/** #44: the drive delete response mirrors the move's async task shape. */
interface DeleteTaskData {
  task_id?: string;
}

interface MoveTaskCheckData {
  status: 'success' | 'fail' | 'process';
}

interface ExportPollData {
  job_status: number;
  msg?: string;
  result?: { file_token: string };
}

interface SheetListData {
  sheets: Array<{ sheet_id: string; title: string; index: number }>;
}

interface SheetReadData {
  valueRange: { range: string; values: (string | number | boolean | null)[][] };
}

interface SheetWriteData {
  spreadsheetToken: string;
  updatedRange: string;
  updatedCells: number;
}

interface BitableTablesData {
  items: Array<{ table_id: string; name: string }>;
}

interface BitableRecordsData {
  items: Array<{ record_id: string; fields: Record<string, unknown> }>;
}

/** #42: Feishu's pagination markers, shared by the list responses. */
interface Paginated {
  has_more?: boolean;
  page_token?: string;
}

/**
 * Derives the List Envelope's cursor (#42): Feishu's marker pair
 * becomes the platform's opaque next — non-null only when another page
 * exists.
 */
function nextCursor(data: Paginated): string | null {
  return data.has_more && data.page_token ? data.page_token : null;
}

interface BitableCreateData {
  record: { record_id: string; fields: Record<string, unknown> };
}

interface BitableUpdateData {
  record: { record_id: string; fields: Record<string, unknown> };
}

interface SearchFilesData {
  docs_entities: Array<{ docs_token: string; docs_type: string; title: string }>;
}

interface FilesListData {
  files: unknown[];
  has_more: boolean;
  next_page_token: string;
}

interface SendMessageData {
  message_id: string;
}

interface RawContentData {
  content: string;
}

interface MetasData {
  metas: Array<{
    doc_token: string;
    doc_type: string;
    title: string;
    owner_id: string;
    latest_modify_time: string;
  }>;
}

/**
 * Candidate Feishu doc types for the type probe, most common first —
 * the live metas API accepts exactly these values for doc_type.
 */
const DOC_TYPE_CANDIDATES = ['docx', 'sheet', 'bitable', 'doc', 'file', 'mindnote'] as const;

/**
 * Resolves an opaque doc token's real Feishu type (#41). Live finding:
 * there is no single-file metadata GET on the drive API
 * (/drive/v1/files/{token} carries no GET verb), and batch_query needs
 * the very type being asked for — a chicken-and-egg solved by probing
 * the candidates in order: a wrong doc_type answers not-found, the
 * matching one returns the meta. The agent stays zero-burden (opaque ID
 * semantics: only the connector parses IDs). Docx (the common case)
 * costs one call; sheets/bitables two/three.
 */
async function resolveDocMeta(
  request: UpstreamRequest,
  docId: string,
  token: string | undefined,
): Promise<MetasData['metas'][number]> {
  let lastMissing: ActionError | undefined;
  for (const docType of DOC_TYPE_CANDIDATES) {
    try {
      const response = await request<DocsEnvelope<MetasData>>(
        '/open-apis/drive/v1/metas/batch_query',
        {
          method: 'POST',
          token,
          body: { request_docs: [{ doc_token: docId, doc_type: docType }] },
        },
      );
      const meta = response.data.metas[0];
      if (meta) return meta;
    } catch (err) {
      // A wrong-type probe answers not_found — try the next candidate.
      // Anything else (auth_expired, rate_limited, upstream_error) is a
      // real failure for the file's true type too: rethrow immediately.
      if (err instanceof ActionError && err.code === 'not_found') {
        lastMissing = err;
        continue;
      }
      throw err;
    }
  }
  // Every candidate missed: the token matches no file the connection
  // can see — the last probe's not_found is the answer.
  if (lastMissing) throw lastMissing;
  throw new ActionError('not_found', `Document "${docId}" not found`);
}

/**
 * Appends one text block to a document via Feishu's blocks API: resolves
 * the document's root block, then posts a text block (block_type 2) as its
 * child. Shared by create_doc's initial content and append_doc_content.
 */
async function appendBlocks(
  request: UpstreamRequest,
  docId: string,
  content: string,
  token: string | undefined,
): Promise<void> {
  const blocks = await request<DocsEnvelope<BlocksData>>(
    `/open-apis/docx/v1/documents/${encodeURIComponent(docId)}/blocks`,
    { token },
  );
  // Live shape (T9 demo pass): the real API reports the root block's
  // parent_id as '' (the mock pinned null; both are roots).
  const root = blocks.data.items.find((block) => block.parent_id === null || block.parent_id === '');
  if (!root) {
    throw new ActionError('upstream_error', `Feishu document "${docId}" has no root block`);
  }
  await request(
    `/open-apis/docx/v1/documents/${encodeURIComponent(docId)}/blocks/${encodeURIComponent(root.block_id)}/children`,
    {
      method: 'POST',
      token,
      body: {
        children: [
          {
            block_type: 2,
            text: {
              elements: [{ text_run: { content } }],
            },
          },
        ],
      },
    },
  );
}

/**
 * Resolves a Bitable table's id from its display name via the app's
 * tables endpoint; throws not_found when the table does not exist.
 */
async function resolveBitableTable(
  request: UpstreamRequest,
  appToken: string,
  tableName: string,
  token: string | undefined,
): Promise<string> {
  const tables = await request<DocsEnvelope<BitableTablesData>>(
    `/open-apis/bitable/v1/apps/${encodeURIComponent(appToken)}/tables`,
    { token },
  );
  const table = tables.data.items.find((candidate) => candidate.name === tableName);
  if (!table) {
    throw new ActionError(
      'not_found',
      `Bitable table "${tableName}" not found in app "${appToken}"`,
    );
  }
  return table.table_id;
}

/**
 * Resolves a spreadsheet tab's sheet id from its display name via the
 * sheets query API; defaults to the first sheet. Live finding (T9 demo
 * pass): Feishu's values API only accepts sheet IDs in ranges — names
 * return 90215 — so the platform's sheet_name must be resolved here.
 */
async function resolveSheetId(
  request: UpstreamRequest,
  spreadsheetToken: string,
  sheetName: string | undefined,
  token: string | undefined,
): Promise<string> {
  const response = await request<DocsEnvelope<SheetListData>>(
    `/open-apis/sheets/v3/spreadsheets/${encodeURIComponent(spreadsheetToken)}/sheets/query`,
    { token },
  );
  const sheets = response.data.sheets.sort((a, b) => a.index - b.index);
  if (sheetName !== undefined) {
    const sheet = sheets.find((candidate) => candidate.title === sheetName);
    if (!sheet) {
      throw new ActionError(
        'not_found',
        `Sheet "${sheetName}" not found in spreadsheet "${spreadsheetToken}"`,
      );
    }
    return sheet.sheet_id;
  }
  const first = sheets[0];
  if (!first) {
    throw new ActionError('upstream_error', `Spreadsheet "${spreadsheetToken}" has no sheets`);
  }
  return first.sheet_id;
}

/** Extracts the page (title) text from a docx block payload. */
function extractPageTitle(block: { page?: { elements: Array<{ text_run?: { content?: string } }> } }): string {
  const element = block.page?.elements[0];
  return element?.text_run?.content ?? '';
}

/**
 * Normalizes a Feishu timestamp to ISO-8601: unix seconds (the live metas
 * shape) are converted; already-ISO values (the mock's shape) pass through.
 */
function toIsoTimestamp(value: string): string {
  const seconds = Number(value);
  if (Number.isFinite(seconds) && String(seconds) === value.trim()) {
    return new Date(seconds * 1000).toISOString();
  }
  return value;
}
