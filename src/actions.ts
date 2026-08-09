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
  url: string;
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
    url: { type: 'string' },
  },
  required: ['doc_id', 'title', 'url'],
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
    description:
      'Create a new document and return its opaque doc_id, title and URL. ' +
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
];
