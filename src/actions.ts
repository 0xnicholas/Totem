import type { JSONSchemaType } from 'ajv';
import type { Action } from './action.js';
import type { DownloadedFile } from './upstream-http.js';

export interface CreateDocInput {
  title: string;
  folder_id?: string;
  content?: string;
}

export interface CreateDocOutput {
  doc_id: string;
  title: string;
}

export interface SearchDocsInput {
  /** Free-text query; matches document titles. */
  query: string;
  /** Max result count (1–100, default 50). */
  limit?: number;
  /** Pagination cursor: the `next` value from the previous page (#42). */
  page_token?: string;
}

export interface SearchDocsOutput {
  /** Matching documents. */
  data: Array<{ doc_id: string; title: string; doc_type: string }>;
  /** Pagination cursor: non-null when more results exist; pass back as page_token (#42). */
  next: string | null;
}

export interface GetDocContentInput {
  doc_id: string;
}

export interface GetDocContentOutput {
  doc_id: string;
  /** The document's full content as plain text (markdown-style headings preserved). */
  content: string;
}

export interface GetDocMetadataInput {
  doc_id: string;
}

export interface GetDocMetadataOutput {
  doc_id: string;
  title: string;
  owner_id: string;
  doc_type: string;
  /** ISO timestamp of the last edit. */
  edited_at: string;
}

export interface AppendDocContentInput {
  doc_id: string;
  /** Text to append to the end of the document. */
  content: string;
}

export interface AppendDocContentOutput {
  doc_id: string;
  /** The document's full content after the append. */
  content: string;
}

export interface RenameDocInput {
  doc_id: string;
  new_title: string;
}

export interface RenameDocOutput {
  doc_id: string;
  title: string;
}

export interface MoveDocInput {
  doc_id: string;
  /** Opaque target folder id. */
  folder_id: string;
}

export interface MoveDocOutput {
  doc_id: string;
  folder_id: string;
}

export interface DeleteDocInput {
  doc_id: string;
}

export interface DeleteDocOutput {
  /** The deleted document's opaque id — the confirmation the agent acted. */
  doc_id: string;
}

/** A spreadsheet cell value with its native JSON type preserved. */
export type CellValue = string | number | boolean | null;

export interface ExportDocInput {
  doc_id: string;
  /** Export format: 'docx' or 'pdf'. */
  format: 'docx' | 'pdf';
}

export interface ExportDocOutput {
  doc_id: string;
  format: 'docx' | 'pdf';
  /** Opaque token of the exported artifact in the user's drive. */
  artifact_id: string;
  /** Download URL for the artifact (requires the connection's authorization). */
  url: string;
}

export interface GetExportArtifactInput {
  /** Opaque artifact token — the artifact_id from export_doc's output. */
  artifact_id: string;
}

export interface GetExportArtifactOutput {
  artifact_id: string;
  /** The artifact's MIME type as reported upstream ('application/octet-stream' when absent). */
  content_type: string;
  /** Raw byte count of the artifact. */
  size_bytes: number;
  /** The artifact's bytes, base64-encoded — docx/pdf are binary; agents decode. */
  content_base64: string;
}

/**
 * The platform-wide raw-byte cap for `get_export_artifact` (#43): artifacts
 * up to 10 MiB download; larger ones fail `upstream_error` (not retryable —
 * the artifact will not shrink) before any surface sees bytes. The single
 * constant every connector passes to the kernel's download guard, so the
 * cap is uniform across providers.
 */
export const GET_EXPORT_ARTIFACT_MAX_BYTES = 10 * 1024 * 1024;

/**
 * Shapes a downloaded artifact into the canonical get_export_artifact
 * output — the one place the base64/size/content-type conventions live, so
 * every connector (and the fake) produces the identical vocabulary
 * (#43). Node-only by design: Buffer is the platform's encoding tool.
 */
export function toArtifactOutput(
  artifactId: string,
  file: DownloadedFile,
): GetExportArtifactOutput {
  return {
    artifact_id: artifactId,
    content_type: file.contentType ?? 'application/octet-stream',
    size_bytes: file.bytes.byteLength,
    content_base64: Buffer.from(file.bytes).toString('base64'),
  };
}

export interface ReadSheetCellsInput {
  /** Opaque id of the spreadsheet (its drive file token). */
  doc_id: string;
  /**
   * The tab to read, by its display name. Defaults to the first sheet.
   * (Feishu's values API only accepts sheet IDs in ranges — the connector
   * resolves the name — live-verified in the T9 demo pass.)
   */
  sheet_name?: string;
  /** Cell range within the sheet, e.g. 'A1:C3'. */
  range: string;
}

export interface ReadSheetCellsOutput {
  doc_id: string;
  range: string;
  /** The range's cells, row-major, with native value types preserved. */
  data: CellValue[][];
  /** Pagination cursor: non-null when more results exist; pass back as page_token (#42). */
  next: string | null;
}

export interface WriteSheetCellsInput {
  /** Opaque id of the spreadsheet (its drive file token). */
  doc_id: string;
  /** The tab to write to, by its display name. Defaults to the first sheet. */
  sheet_name?: string;
  /** Cell range within the sheet, e.g. 'A1:C3'. */
  range: string;
  /** Row-major values to write; must match the range's shape. */
  values: CellValue[][];
}

export interface WriteSheetCellsOutput {
  doc_id: string;
  range: string;
  /** Number of cells written. */
  updated_cells: number;
}

export interface ReadBitableRecordsInput {
  /** Opaque id of the Bitable app (its drive file token). */
  doc_id: string;
  /** The table to read, by its display name. */
  table_name: string;
  /** Max records to return (1–100, default 100). */
  limit?: number;
  /** Pagination cursor: the `next` value from the previous page (#42). */
  page_token?: string;
}

export interface ReadBitableRecordsOutput {
  doc_id: string;
  table_name: string;
  /** Records with their field-name-based values. */
  data: Array<{ record_id: string; fields: Record<string, unknown> }>;
  /** Pagination cursor: non-null when more results exist; pass back as page_token (#42). */
  next: string | null;
}

export interface WriteBitableRecordsInput {
  /** Opaque id of the Bitable app (its drive file token). */
  doc_id: string;
  /** The table to write to, by its display name. */
  table_name: string;
  /** Field-name-based values for the new record. */
  fields: Record<string, unknown>;
}

export interface WriteBitableRecordsOutput {
  doc_id: string;
  table_name: string;
  /** The created record's opaque id. */
  record_id: string;
}

export interface UpdateBitableRecordsInput {
  /** Opaque id of the Bitable app (its drive file token). */
  doc_id: string;
  /** The table holding the record, by its display name. */
  table_name: string;
  /** The record to update, by its opaque id. */
  record_id: string;
  /** Field-name-based values to overwrite on the record. */
  fields: Record<string, unknown>;
}

export interface UpdateBitableRecordsOutput {
  doc_id: string;
  table_name: string;
  /** The updated record's opaque id. */
  record_id: string;
  /** The record's full field-name-based values after the update. */
  fields: Record<string, unknown>;
}

export interface DeleteBitableRecordsInput {
  /** Opaque id of the Bitable app (its drive file token). */
  doc_id: string;
  /** The table holding the records, by its display name. */
  table_name: string;
  /** The records to delete, by their opaque ids. 1–500 per call (Feishu's cap). */
  record_ids: string[];
}

export interface DeleteBitableRecordsOutput {
  doc_id: string;
  table_name: string;
  /** How many records were deleted (the batch succeeded as a unit). */
  deleted_count: number;
}

export interface SendMessageInput {
  /**
   * Recipient email (a user). Exactly one of `email` / `chat_id` is
   * required — the schema rejects both-absent and both-present.
   */
  email?: string;
  /**
   * Opaque id of the target chat (a group conversation). Exactly one of
   * `email` / `chat_id` is required.
   */
  chat_id?: string;
  /** Plain-text message content. */
  content: string;
}

export interface SendMessageOutput {
  /** The sent message's opaque id. */
  message_id: string;
}

const createDocInputSchema: JSONSchemaType<CreateDocInput> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    title: { type: 'string', minLength: 1 },
    folder_id: { type: 'string', nullable: true },
    content: { type: 'string', nullable: true },
  },
  required: ['title'],
};

const createDocOutputSchema: JSONSchemaType<CreateDocOutput> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    doc_id: { type: 'string' },
    title: { type: 'string' },
  },
  required: ['doc_id', 'title'],
};

const searchDocsInputSchema: JSONSchemaType<SearchDocsInput> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    query: { type: 'string', minLength: 1 },
    limit: { type: 'integer', nullable: true, minimum: 1, maximum: 100 },
    page_token: { type: 'string', nullable: true },
  },
  required: ['query'],
};

/**
 * Schema for a required nullable string (the pagination cursor).
 *
 * ajv's JSONSchemaType cannot express a required `string | null` property:
 * `nullable: true` is only permitted for optional properties (Nullable<T>
 * keys off `undefined extends T`), so this is the standard workaround —
 * defined once, referenced by every list output schema.
 */
const nullableStringSchema = {
  anyOf: [{ type: 'string' }, { type: 'null' }],
  // ajv does not export the single-property schema type; `never` is
  // assignable to every property-schema position (lint-safe, unlike any).
} as unknown as never;

const searchDocsOutputSchema: JSONSchemaType<SearchDocsOutput> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    data: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          doc_id: { type: 'string' },
          title: { type: 'string' },
          doc_type: { type: 'string' },
        },
        required: ['doc_id', 'title', 'doc_type'],
      },
    },
    next: nullableStringSchema,
  },
  required: ['data', 'next'],
};

const docIdInputSchema: JSONSchemaType<{ doc_id: string }> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    doc_id: { type: 'string' },
  },
  required: ['doc_id'],
};

const getDocContentOutputSchema: JSONSchemaType<GetDocContentOutput> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    doc_id: { type: 'string' },
    content: { type: 'string' },
  },
  required: ['doc_id', 'content'],
};

const appendDocContentInputSchema: JSONSchemaType<AppendDocContentInput> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    doc_id: { type: 'string' },
    content: { type: 'string', minLength: 1 },
  },
  required: ['doc_id', 'content'],
};

const appendDocContentOutputSchema: JSONSchemaType<AppendDocContentOutput> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    doc_id: { type: 'string' },
    content: { type: 'string' },
  },
  required: ['doc_id', 'content'],
};

const renameDocInputSchema: JSONSchemaType<RenameDocInput> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    doc_id: { type: 'string' },
    new_title: { type: 'string', minLength: 1 },
  },
  required: ['doc_id', 'new_title'],
};

const renameDocOutputSchema: JSONSchemaType<RenameDocOutput> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    doc_id: { type: 'string' },
    title: { type: 'string' },
  },
  required: ['doc_id', 'title'],
};

const moveDocInputSchema: JSONSchemaType<MoveDocInput> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    doc_id: { type: 'string' },
    folder_id: { type: 'string', minLength: 1 },
  },
  required: ['doc_id', 'folder_id'],
};

const moveDocOutputSchema: JSONSchemaType<MoveDocOutput> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    doc_id: { type: 'string' },
    folder_id: { type: 'string' },
  },
  required: ['doc_id', 'folder_id'],
};

const deleteDocInputSchema: JSONSchemaType<DeleteDocInput> = docIdInputSchema;

const deleteDocOutputSchema: JSONSchemaType<DeleteDocOutput> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    doc_id: { type: 'string' },
  },
  required: ['doc_id'],
};

// JSONSchemaType cannot infer unions from oneOf; the runtime schema below
// is exact, so the cast only satisfies the generic.
const cellValueSchema = {
  oneOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }, { type: 'null' }],
} as JSONSchemaType<CellValue>;

const exportDocInputSchema: JSONSchemaType<ExportDocInput> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    doc_id: { type: 'string' },
    format: { type: 'string', enum: ['docx', 'pdf'] },
  },
  required: ['doc_id', 'format'],
};

const exportDocOutputSchema: JSONSchemaType<ExportDocOutput> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    doc_id: { type: 'string' },
    format: { type: 'string', enum: ['docx', 'pdf'] },
    artifact_id: { type: 'string' },
    url: { type: 'string' },
  },
  required: ['doc_id', 'format', 'artifact_id', 'url'],
};

const getExportArtifactInputSchema: JSONSchemaType<GetExportArtifactInput> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    artifact_id: { type: 'string', minLength: 1 },
  },
  required: ['artifact_id'],
};

const getExportArtifactOutputSchema: JSONSchemaType<GetExportArtifactOutput> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    artifact_id: { type: 'string' },
    content_type: { type: 'string', minLength: 1 },
    size_bytes: { type: 'integer', minimum: 0 },
    content_base64: { type: 'string' },
  },
  required: ['artifact_id', 'content_type', 'size_bytes', 'content_base64'],
};

const readSheetCellsInputSchema: JSONSchemaType<ReadSheetCellsInput> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    doc_id: { type: 'string' },
    sheet_name: { type: 'string', nullable: true, minLength: 1 },
    range: { type: 'string', minLength: 1 },
  },
  required: ['doc_id', 'range'],
};

const cellMatrixSchema: JSONSchemaType<CellValue[][]> = {
  type: 'array',
  items: {
    type: 'array',
    items: cellValueSchema,
  },
};

const readSheetCellsOutputSchema: JSONSchemaType<ReadSheetCellsOutput> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    doc_id: { type: 'string' },
    range: { type: 'string' },
    data: cellMatrixSchema,
    next: nullableStringSchema,
  },
  required: ['doc_id', 'range', 'data', 'next'],
};

const writeSheetCellsInputSchema: JSONSchemaType<WriteSheetCellsInput> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    doc_id: { type: 'string' },
    sheet_name: { type: 'string', nullable: true, minLength: 1 },
    range: { type: 'string', minLength: 1 },
    values: cellMatrixSchema,
  },
  required: ['doc_id', 'range', 'values'],
};

const writeSheetCellsOutputSchema: JSONSchemaType<WriteSheetCellsOutput> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    doc_id: { type: 'string' },
    range: { type: 'string' },
    updated_cells: { type: 'number' },
  },
  required: ['doc_id', 'range', 'updated_cells'],
};

const bitableRecordListSchema: JSONSchemaType<
  Array<{ record_id: string; fields: Record<string, unknown> }>
> = {
  type: 'array',
  items: {
    type: 'object',
    additionalProperties: false,
    properties: {
      record_id: { type: 'string' },
      fields: { type: 'object', additionalProperties: true },
    },
    required: ['record_id', 'fields'],
  },
};

const readBitableRecordsInputSchema: JSONSchemaType<ReadBitableRecordsInput> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    doc_id: { type: 'string' },
    table_name: { type: 'string', minLength: 1 },
    limit: { type: 'integer', nullable: true, minimum: 1, maximum: 100 },
    page_token: { type: 'string', nullable: true },
  },
  required: ['doc_id', 'table_name'],
};

const readBitableRecordsOutputSchema: JSONSchemaType<ReadBitableRecordsOutput> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    doc_id: { type: 'string' },
    table_name: { type: 'string' },
    data: bitableRecordListSchema,
    next: nullableStringSchema,
  },
  required: ['doc_id', 'table_name', 'data', 'next'],
};

const writeBitableRecordsInputSchema: JSONSchemaType<WriteBitableRecordsInput> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    doc_id: { type: 'string' },
    table_name: { type: 'string', minLength: 1 },
    fields: { type: 'object', additionalProperties: true },
  },
  required: ['doc_id', 'table_name', 'fields'],
};

const writeBitableRecordsOutputSchema: JSONSchemaType<WriteBitableRecordsOutput> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    doc_id: { type: 'string' },
    table_name: { type: 'string' },
    record_id: { type: 'string' },
  },
  required: ['doc_id', 'table_name', 'record_id'],
};

const updateBitableRecordsInputSchema: JSONSchemaType<UpdateBitableRecordsInput> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    doc_id: { type: 'string' },
    table_name: { type: 'string', minLength: 1 },
    record_id: { type: 'string', minLength: 1 },
    fields: { type: 'object', additionalProperties: true },
  },
  required: ['doc_id', 'table_name', 'record_id', 'fields'],
};

const updateBitableRecordsOutputSchema: JSONSchemaType<UpdateBitableRecordsOutput> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    doc_id: { type: 'string' },
    table_name: { type: 'string' },
    record_id: { type: 'string' },
    fields: { type: 'object', additionalProperties: true },
  },
  required: ['doc_id', 'table_name', 'record_id', 'fields'],
};

const deleteBitableRecordsInputSchema: JSONSchemaType<DeleteBitableRecordsInput> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    doc_id: { type: 'string' },
    table_name: { type: 'string', minLength: 1 },
    record_ids: {
      type: 'array',
      items: { type: 'string', minLength: 1 },
      minItems: 1,
      // Feishu's batch_delete caps a call at 500 records (doc-verified).
      maxItems: 500,
    },
  },
  required: ['doc_id', 'table_name', 'record_ids'],
};

const deleteBitableRecordsOutputSchema: JSONSchemaType<DeleteBitableRecordsOutput> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    doc_id: { type: 'string' },
    table_name: { type: 'string' },
    deleted_count: { type: 'integer', minimum: 0 },
  },
  required: ['doc_id', 'table_name', 'deleted_count'],
};

/**
 * Exactly-one-of addressing for `send_message` (ADR-0016): the email /
 * chat_id union is a JSON Schema `oneOf` with negation, which
 * `JSONSchemaType` cannot infer — same escape hatch as `cellValueSchema`.
 *
 * The oneOf keys on property PRESENCE, so the property schemas must not
 * be nullable (#56): `{email: null}` would otherwise validate (the
 * property is present), reach the connector as a null recipient, and
 * surface as an opaque upstream failure instead of validation_error.
 * Null is absent-with-no-fallback here — unlike repo-wide optional
 * strings, neither branch may fall back when the value is null.
 */
const sendMessageInputSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    email: { type: 'string', minLength: 1 },
    chat_id: { type: 'string', minLength: 1 },
    content: { type: 'string', minLength: 1 },
  },
  required: ['content'],
  oneOf: [
    { required: ['email'], not: { required: ['chat_id'] } },
    { required: ['chat_id'], not: { required: ['email'] } },
  ],
} as unknown as JSONSchemaType<SendMessageInput>;

const sendMessageOutputSchema: JSONSchemaType<SendMessageOutput> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    message_id: { type: 'string' },
  },
  required: ['message_id'],
};

const getDocMetadataOutputSchema: JSONSchemaType<GetDocMetadataOutput> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    doc_id: { type: 'string' },
    title: { type: 'string' },
    owner_id: { type: 'string' },
    doc_type: { type: 'string' },
    edited_at: { type: 'string' },
  },
  required: ['doc_id', 'title', 'owner_id', 'doc_type', 'edited_at'],
};

/**
 * v1 platform action set for the Docs domain (ADR-0001): the platform owns
 * these definitions; connectors declare what they implement and translate
 * into the platform vocabulary. IDs are unified opaque IDs (`doc_id`,
 * `folder_id`) — the connector is responsible for parse/format; v1 may map
 * them trivially to system tokens.
 */
export const DOCS_ACTIONS: Action[] = [
  {
    name: 'create_doc',
    // Live finding (T9 demo pass): Feishu's create API returns no URL, so
    // the output carries doc_id + title only.
    description:
      'Create a new document and return its opaque doc_id and title. ' +
      'Optionally place it in a folder (folder_id) and seed it with initial content.',
    inputSchema: createDocInputSchema,
    outputSchema: createDocOutputSchema,
    effects: 'write',
  },
  {
    name: 'search_docs',
    description:
      "Search the tenant's documents by a text query (matches titles) and return matching " +
      'documents with their opaque doc_id, title and type. ' +
      'Cap the result count with limit (1–100, default 50); when more results exist the ' +
      'output carries a non-null next cursor — pass it back as page_token to fetch the ' +
      'next page.',
    inputSchema: searchDocsInputSchema,
    outputSchema: searchDocsOutputSchema,
    effects: 'read',
  },
  {
    name: 'get_doc_content',
    description:
      "Read a document's full content by its opaque doc_id. Content is returned as plain " +
      'text with markdown-style headings preserved — ideal for summarising or quoting. ' +
      'Use get_doc_metadata for title, owner and type.',
    inputSchema: docIdInputSchema,
    outputSchema: getDocContentOutputSchema,
    effects: 'read',
  },
  {
    name: 'get_doc_metadata',
    description:
      "Get a document's metadata by its opaque doc_id: title, owner, document type " +
      '(docx, sheet, bitable, wiki) and last edit time.',
    inputSchema: docIdInputSchema,
    outputSchema: getDocMetadataOutputSchema,
    effects: 'read',
  },
  {
    name: 'append_doc_content',
    description:
      "Append text to the end of an existing document by its opaque doc_id and return the " +
      "document's full updated content. Use create_doc to create a document first.",
    inputSchema: appendDocContentInputSchema,
    outputSchema: appendDocContentOutputSchema,
    effects: 'write',
  },
  {
    name: 'rename_doc',
    description:
      "Rename an existing document by its opaque doc_id. Returns the document's id and new title.",
    inputSchema: renameDocInputSchema,
    outputSchema: renameDocOutputSchema,
    effects: 'write',
  },
  {
    name: 'move_doc',
    description:
      "Move an existing document by its opaque doc_id into a folder (folder_id). " +
      'Returns the document id and the target folder id.',
    inputSchema: moveDocInputSchema,
    outputSchema: moveDocOutputSchema,
    effects: 'write',
  },
  {
    name: 'delete_doc',
    // The platform's first destructive-class action (ADR-0018): the class
    // contract (acknowledged allowlisting, fail-closed input screening,
    // always-audited) rides on this effects value alone.
    description:
      'Delete a document by its opaque doc_id. DESTRUCTIVE and irreversible: the ' +
      "document disappears from everything the connection can see (Feishu moves it to the " +
      "system's trash, where only a human user may restore it — agents cannot). Confirm with " +
      'the user before calling. Returns the deleted document id.',
    inputSchema: deleteDocInputSchema,
    outputSchema: deleteDocOutputSchema,
    effects: 'destructive',
  },
  {
    name: 'export_doc',
    // Live finding (T9 demo pass): Feishu's export API supports
    // [docx, pdf, xlsx, csv, base, pptx] — there is NO markdown export, so
    // the original 'md' format was dropped from the platform vocabulary.
    description:
      "Export a document by its opaque doc_id into a portable format: 'docx' or 'pdf'. " +
      'Returns an artifact reference: the exported file token (artifact_id) and its drive URL. ' +
      "The URL requires the connection's authorization, so the agent cannot fetch it — pass " +
      'artifact_id to get_export_artifact and the platform downloads the bytes for you.',
    inputSchema: exportDocInputSchema,
    outputSchema: exportDocOutputSchema,
    // Export creates an artifact on the upstream side but never changes the
    // document itself — read class, like the rest of the metadata surface.
    effects: 'read',
  },
  {
    name: 'get_export_artifact',
    description:
      "Download an export artifact by its opaque artifact_id (from export_doc's output) and " +
      "return its bytes base64-encoded, with the artifact's content type and size. The platform " +
      "fetches the artifact with the connection's authorization — the export URL itself is " +
      'unreachable to agents. Artifacts are capped at 10 MiB; larger ones fail with a ' +
      'non-retryable upstream_error.',
    inputSchema: getExportArtifactInputSchema,
    outputSchema: getExportArtifactOutputSchema,
    // A pure download: no upstream state changes (the artifact already
    // exists from export_doc).
    effects: 'read',
  },
  {
    name: 'read_sheet_cells',
    description:
      "Read a range of cells from a spreadsheet by its opaque doc_id. sheet_name selects the " +
      "tab (defaults to the first sheet); range is the cell range within it, e.g. 'A1:C3'. " +
      'Cell values keep their native JSON types (string, number, boolean or null).',
    inputSchema: readSheetCellsInputSchema,
    outputSchema: readSheetCellsOutputSchema,
    effects: 'read',
  },
  {
    name: 'write_sheet_cells',
    description:
      "Write values into a spreadsheet by its opaque doc_id. sheet_name selects the tab " +
      "(defaults to the first sheet); range is the cell range within it, e.g. 'A1:B2'. Values " +
      'is a row-major 2-D array whose shape must match the range. Returns the number of cells ' +
      'updated.',
    inputSchema: writeSheetCellsInputSchema,
    outputSchema: writeSheetCellsOutputSchema,
    effects: 'write',
  },
  {
    name: 'feishu_read_bitable_records',
    description:
      "Read records from a Bitable table by its app's opaque doc_id and the table's display " +
      'name. Records come back with their field-name-based values; cap the result count with ' +
      'limit (1–100, default 100). When more records exist the output carries a non-null ' +
      'next cursor — pass it back as page_token to fetch the next page.',
    inputSchema: readBitableRecordsInputSchema,
    outputSchema: readBitableRecordsOutputSchema,
    effects: 'read',
    provider: 'feishu',
  },
  {
    name: 'feishu_write_bitable_records',
    description:
      "Create one record in a Bitable table by its app's opaque doc_id and the table's display " +
      "name, with field-name-based values. Returns the new record's opaque id.",
    inputSchema: writeBitableRecordsInputSchema,
    outputSchema: writeBitableRecordsOutputSchema,
    effects: 'write',
    provider: 'feishu',
  },
  {
    name: 'feishu_update_bitable_records',
    description:
      "Update one record in a Bitable table by its app's opaque doc_id, the table's display " +
      "name and the record's opaque id. Only the given field-name-based values are " +
      'overwritten; other fields keep their current values. Returns the record with its ' +
      'full values after the update.',
    inputSchema: updateBitableRecordsInputSchema,
    outputSchema: updateBitableRecordsOutputSchema,
    effects: 'write',
    provider: 'feishu',
  },
  {
    name: 'feishu_delete_bitable_records',
    // Destructive-class (ADR-0018): same class contract as delete_doc,
    // provider-scoped because batch delete is Feishu-shaped.
    description:
      'Delete records from a Bitable table by their opaque record_ids (1–500 per call). ' +
      'DESTRUCTIVE and irreversible: the records are permanently removed from the table ' +
      'and cannot be restored by agents. Confirm with the user before calling. Returns ' +
      'the table identity and how many records were deleted.',
    inputSchema: deleteBitableRecordsInputSchema,
    outputSchema: deleteBitableRecordsOutputSchema,
    effects: 'destructive',
    provider: 'feishu',
  },
];

export interface TestConnectionOutput {
  /** The connection that was tested (the caller-selected connection). */
  connection_id: string;
  /**
   * Always `ok` on success — the action executed, so the connection's
   * auth and API access work. Failures are vocabulary errors, never a
   * non-ok status in a successful result.
   */
  status: 'ok';
}

const testConnectionInputSchema: JSONSchemaType<Record<string, never>> = {
  type: 'object',
  additionalProperties: false,
  properties: {},
  required: [],
};

const testConnectionOutputSchema: JSONSchemaType<TestConnectionOutput> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    connection_id: { type: 'string' },
    status: { type: 'string', enum: ['ok'] },
  },
  required: ['connection_id', 'status'],
};

/**
 * The v1 platform connection actions (T10): actions every connector
 * implements, owned by the platform like the Docs domain actions
 * (ADR-0001). `test_connection` closes the connection-lifecycle loop —
 * operators and agents can verify a connection's auth and API access
 * without executing a real action.
 */
export const CONNECTION_ACTIONS: Action[] = [
  {
    name: 'test_connection',
    description:
      "Verify that this connection's authentication and API access are working, without " +
      'executing any real action. Returns the connection id and status (ok). Safe to call ' +
      'anytime; read-only.',
    inputSchema: testConnectionInputSchema,
    outputSchema: testConnectionOutputSchema,
    effects: 'read',
  },
];

/**
 * The messaging domain (ADR-0016): the platform's first non-doc action
 * family, entering on the catalog-driven roadmap. `send_message` is
 * canonical — the schema is designed against concepts the providers share
 * (natural-key email addressing, opaque chat ids), so Feishu implements it
 * now and DingTalk / WeCom follow in later batches.
 */
export const MESSAGING_ACTIONS: Action[] = [
  {
    name: 'send_message',
    description:
      'Send a plain-text message to a user by email, or to a chat by its opaque chat_id ' +
      '(exactly one of email/chat_id). The message is sent with the identity of this ' +
      "connection — the owner's identity on user-grant systems, the app identity where the " +
      "system only knows applications (DingTalk messaging, WeCom). Returns the sent " +
      "message's opaque message_id.",
    inputSchema: sendMessageInputSchema,
    outputSchema: sendMessageOutputSchema,
    effects: 'write',
  },
];
