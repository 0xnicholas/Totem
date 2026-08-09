import type { JSONSchemaType } from 'ajv';
import type { Action } from './action.js';

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
}

export interface SearchDocsOutput {
  docs: Array<{ doc_id: string; title: string; doc_type: string }>;
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
  /** Download URL for the artifact (requires the connection's Feishu auth). */
  url: string;
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
  values: CellValue[][];
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
}

export interface ReadBitableRecordsOutput {
  doc_id: string;
  table_name: string;
  /** Records with their field-name-based values. */
  records: Array<{ record_id: string; fields: Record<string, unknown> }>;
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
  },
  required: ['query'],
};

const searchDocsOutputSchema: JSONSchemaType<SearchDocsOutput> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    docs: {
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
  },
  required: ['docs'],
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
    values: cellMatrixSchema,
  },
  required: ['doc_id', 'range', 'values'],
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
  },
  required: ['doc_id', 'table_name'],
};

const readBitableRecordsOutputSchema: JSONSchemaType<ReadBitableRecordsOutput> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    doc_id: { type: 'string' },
    table_name: { type: 'string' },
    records: bitableRecordListSchema,
  },
  required: ['doc_id', 'table_name', 'records'],
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
  },
  {
    name: 'search_docs',
    description:
      "Search the tenant's documents by a text query (matches titles) and return matching " +
      'documents with their opaque doc_id, title and type. ' +
      'Cap the result count with limit (1–100, default 50).',
    inputSchema: searchDocsInputSchema,
    outputSchema: searchDocsOutputSchema,
  },
  {
    name: 'get_doc_content',
    description:
      "Read a document's full content by its opaque doc_id. Content is returned as plain " +
      'text with markdown-style headings preserved — ideal for summarising or quoting. ' +
      'Use get_doc_metadata for title, owner and type.',
    inputSchema: docIdInputSchema,
    outputSchema: getDocContentOutputSchema,
  },
  {
    name: 'get_doc_metadata',
    description:
      "Get a document's metadata by its opaque doc_id: title, owner, document type " +
      '(docx, sheet, bitable, wiki) and last edit time.',
    inputSchema: docIdInputSchema,
    outputSchema: getDocMetadataOutputSchema,
  },
  {
    name: 'append_doc_content',
    description:
      "Append text to the end of an existing document by its opaque doc_id and return the " +
      "document's full updated content. Use create_doc to create a document first.",
    inputSchema: appendDocContentInputSchema,
    outputSchema: appendDocContentOutputSchema,
  },
  {
    name: 'rename_doc',
    description:
      "Rename an existing document by its opaque doc_id. Returns the document's id and new title.",
    inputSchema: renameDocInputSchema,
    outputSchema: renameDocOutputSchema,
  },
  {
    name: 'move_doc',
    description:
      "Move an existing document by its opaque doc_id into a folder (folder_id). " +
      'Returns the document id and the target folder id.',
    inputSchema: moveDocInputSchema,
    outputSchema: moveDocOutputSchema,
  },
  {
    name: 'export_doc',
    // Live finding (T9 demo pass): Feishu's export API supports
    // [docx, pdf, xlsx, csv, base, pptx] — there is NO markdown export, so
    // the original 'md' format was dropped from the platform vocabulary.
    description:
      "Export a document by its opaque doc_id into a portable format: 'docx' or 'pdf'. " +
      'Returns an artifact reference: the exported file token and its download URL (fetching ' +
      "the artifact requires the connection's Feishu authorization).",
    inputSchema: exportDocInputSchema,
    outputSchema: exportDocOutputSchema,
  },
  {
    name: 'read_sheet_cells',
    description:
      "Read a range of cells from a spreadsheet by its opaque doc_id. sheet_name selects the " +
      "tab (defaults to the first sheet); range is the cell range within it, e.g. 'A1:C3'. " +
      'Cell values keep their native JSON types (string, number, boolean or null).',
    inputSchema: readSheetCellsInputSchema,
    outputSchema: readSheetCellsOutputSchema,
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
  },
  {
    name: 'read_bitable_records',
    description:
      "Read records from a Bitable table by its app's opaque doc_id and the table's display " +
      'name. Records come back with their field-name-based values; cap the result count with ' +
      'limit (1–100, default 100).',
    inputSchema: readBitableRecordsInputSchema,
    outputSchema: readBitableRecordsOutputSchema,
  },
  {
    name: 'write_bitable_records',
    description:
      "Create one record in a Bitable table by its app's opaque doc_id and the table's display " +
      "name, with field-name-based values. Returns the new record's opaque id.",
    inputSchema: writeBitableRecordsInputSchema,
    outputSchema: writeBitableRecordsOutputSchema,
  },
];
