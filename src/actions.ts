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

export interface ReadDocInput {
  doc_id: string;
}

export interface ReadDocOutput {
  doc_id: string;
  title: string;
  content: string;
}

export interface ListDocsInput {
  limit?: number;
}

export interface ListDocsOutput {
  docs: Array<{ doc_id: string; title: string }>;
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

const readDocInputSchema: JSONSchemaType<ReadDocInput> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    doc_id: { type: 'string' },
  },
  required: ['doc_id'],
};

const readDocOutputSchema: JSONSchemaType<ReadDocOutput> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    doc_id: { type: 'string' },
    title: { type: 'string' },
    content: { type: 'string' },
  },
  required: ['doc_id', 'title', 'content'],
};

const listDocsInputSchema: JSONSchemaType<ListDocsInput> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    limit: { type: 'integer', nullable: true, minimum: 1, maximum: 100 },
  },
  required: [],
};

const listDocsOutputSchema: JSONSchemaType<ListDocsOutput> = {
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
        },
        required: ['doc_id', 'title'],
      },
    },
  },
  required: ['docs'],
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
    name: 'read_doc',
    description: "Read a document's title and content by its opaque doc_id.",
    inputSchema: readDocInputSchema,
    outputSchema: readDocOutputSchema,
  },
  {
    name: 'list_docs',
    description:
      'List documents, most recently created first. Limit the result count with limit (1–100).',
    inputSchema: listDocsInputSchema,
    outputSchema: listDocsOutputSchema,
  },
];
