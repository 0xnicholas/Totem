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
];
