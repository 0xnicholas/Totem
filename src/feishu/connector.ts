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
  WriteBitableRecordsInput,
  WriteBitableRecordsOutput,
  WriteSheetCellsInput,
  WriteSheetCellsOutput,
} from '../actions.js';
import type { IConnector } from '../connector.js';
import { ActionError, errorMessage } from '../errors.js';
import { FeishuApiError } from './oauth.js';
import { createUpstreamHttp, type UpstreamRequest, type UpstreamRequestOptions } from '../upstream-http.js';

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
      'export_doc',
      'read_sheet_cells',
      'write_sheet_cells',
      'feishu_read_bitable_records',
      'feishu_write_bitable_records',
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
  private readonly request: UpstreamRequest;

  constructor(
    private readonly baseUrl: string,
    options: FeishuConnectorOptions = {},
  ) {
    // Live note (T9 demo pass): real export jobs took 40-60s in the live
    // walk, so the default budget is 2 minutes (60 polls × 2s).
    this.exportPollMs = options.exportPollMs ?? 2000;
    this.exportMaxAttempts = options.exportMaxAttempts ?? 60;

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
        const response = await this.docsRequest<SearchFilesData>(
          '/open-apis/drive/v1/files/search',
          {
            method: 'POST',
            token: ctx.token,
            query: { page_size: String(input.limit ?? 50) },
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
          next: null,
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
        const response = await this.docsRequest<UpdateBlockData>(
          `/open-apis/docx/v1/documents/${encodeURIComponent(input.doc_id)}/blocks/${encodeURIComponent(input.doc_id)}`,
          {
            method: 'PATCH',
            token: ctx.token,
            body: {
              update_text_elements: {
                elements: [{ text_run: { content: input.new_title } }],
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
        // Feishu's move is async (returns a task id); the platform contract
        // confirms the target, which is all the agent needs.
        await this.docsRequest(
          `/open-apis/drive/v1/files/${encodeURIComponent(input.doc_id)}/move`,
          {
            method: 'POST',
            token: ctx.token,
            body: { folder_token: input.folder_id, type: 'docx' },
          },
        );
        const output: MoveDocOutput = { doc_id: input.doc_id, folder_id: input.folder_id };
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
            // SOURCE type (type) — without it Feishu returns 99992402.
            body: { type: 'docx', file_extension: input.format, token: input.doc_id },
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
        const response = await this.docsRequest<BitableRecordsData>(
          `/open-apis/bitable/v1/apps/${encodeURIComponent(input.doc_id)}/tables/${encodeURIComponent(tableId)}/records`,
          {
            token: ctx.token,
            query: { page_size: String(input.limit ?? 100) },
          },
        );
        const output: ReadBitableRecordsOutput = {
          doc_id: input.doc_id,
          table_name: input.table_name,
          data: response.data.items.map((record) => ({
            record_id: record.record_id,
            fields: record.fields,
          })),
          next: null,
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

      get_doc_metadata: async (args: GetDocMetadataInput, ctx) => {
        const input = args;
        // v1 boundary: the docs actions address Feishu docx documents — the
        // opaque doc_id carries no type, so non-docx metadata (sheets,
        // bitables) fails on the live API until T9's dedicated actions.
        const response = await this.docsRequest<MetasData>(
          '/open-apis/drive/v1/metas/batch_query',
          {
            method: 'POST',
            token: ctx.token,
            body: { request_docs: [{ doc_token: input.doc_id, doc_type: 'docx' }] },
          },
        );
        const meta = response.data.metas[0]!;
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
    page?: { elements: Array<{ text_run?: { content?: string } }> };
  };
}

interface ExportTaskData {
  ticket: string;
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

interface BitableCreateData {
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
