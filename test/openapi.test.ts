import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { serve, type ServerType } from '@hono/node-server';
import type { AddressInfo } from 'node:net';
import type { Action } from '../src/action.js';
import {
  buildOpenApiDocument,
  createOpenApiApp,
  type OpenApiDocument,
} from '../src/rest/openapi.js';
import { PLATFORM_ACTIONS } from './fixtures.js';

const META = {
  version: '0.1.0',
  title: 'Totem API',
  serverUrl: 'https://totem.example.com',
} as const;

const HIDDEN_ACTION: Action = {
  name: 'platform_internal',
  description: 'Secret bookkeeping.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: { note: { type: 'string' } },
    required: [],
  },
  outputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {},
    required: [],
  },
  effects: 'write',
  hidden: true,
};

/**
 * The OpenAPI surface (T24): a pure generator (`buildOpenApiDocument`)
 * deriving an OpenAPI 3.1 document from the action registry — the
 * machine-readable layer of the Consumption Standard — plus a no-auth
 * `GET /openapi.json` endpoint serving it. Primary seam: the generator
 * (pure function, asserted against the PLATFORM_ACTIONS fixture); secondary
 * seam: the HTTP boundary over loopback (the discovery/rpc test pattern).
 *
 * Representation (per the T24 decision): the three REST routes are
 * documented as-is; the RPC path is a single generic envelope operation
 * (`{action, args}`, ADR-0008), and every visible action's input/output
 * schemas are published verbatim as `components.schemas.<action>_input` /
 * `<action>_output` — the only transformation being the ajv draft-07
 * `nullable: true` → JSON Schema 2020-12 `type: [...]` translation.
 */
describe('buildOpenApiDocument (T24, generator)', () => {
  const doc = buildOpenApiDocument(PLATFORM_ACTIONS, META);

  it('emits an OpenAPI 3.1 document with the injected meta', () => {
    expect(doc.openapi).toBe('3.1.0');
    expect(doc.info.title).toBe(META.title);
    expect(doc.info.version).toBe(META.version);
    expect(doc.servers).toEqual([{ url: META.serverUrl }]);
  });

  it('info.version mirrors whatever version is injected', () => {
    const other = buildOpenApiDocument(PLATFORM_ACTIONS, { ...META, version: '9.9.9-test' });
    expect(other.info.version).toBe('9.9.9-test');
  });

  it('covers exactly the three REST paths', () => {
    expect(Object.keys(doc.paths).sort()).toEqual(['/actions', '/actions/rpc', '/actions/search']);
  });

  it('documents POST /actions/rpc as the generic envelope with the auth contract', () => {
    const rpc = doc.paths['/actions/rpc']!.post!;
    expect(rpc.operationId).toBe('actions_rpc');
    expect(rpc.security!).toEqual([{ bearerAuth: [] }]);
    const connectionId = rpc.parameters![0]!;
    expect(connectionId.name).toBe('x-connection-id');
    expect(connectionId.in).toBe('header');
    expect(connectionId.required).toBe(true);
    expect(connectionId.schema).toEqual({ type: 'string' });
    expect(typeof connectionId.description).toBe('string');
    // The ADR-0008 envelope: a flat {action, args} object — args is the
    // registry input shape, so no path/query/body splitting.
    expect(rpc.requestBody!.content['application/json']!.schema).toEqual({
      type: 'object',
      properties: {
        action: { type: 'string' },
        args: { type: 'object' },
      },
      required: ['action'],
    });
    expect(rpc.responses['200']).toBeDefined();
  });

  it('documents GET /actions and POST /actions/search with the discovery contract', () => {
    const list = doc.paths['/actions']!.get!;
    expect(list.operationId).toBe('list_actions');
    expect(list.security!).toEqual([{ bearerAuth: [] }]);
    expect(list.responses['200']!.content!['application/json']!.schema).toEqual({
      type: 'object',
      additionalProperties: false,
      properties: {
        actions: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              name: { type: 'string' },
              description: { type: 'string' },
              effects: { type: 'string' },
              provider: {
                type: 'string',
                description:
                  "The action's provider scope (ADR-0013): present on provider-native " +
                  'actions only; canonical actions omit the key.',
                enum: ['feishu', 'dingtalk'],
              },
              deprecated: {
                type: 'object',
                description:
                  "The action's deprecation status (ADR-0014): present on " +
                  'deprecated actions only; non-deprecated actions omit the key.',
                additionalProperties: false,
                properties: {
                  replacement: { type: 'string' },
                  sunset: { type: 'string', format: 'date' },
                  note: { type: 'string' },
                },
              },
            },
            required: ['name', 'description', 'effects'],
          },
        },
      },
      required: ['actions'],
    });

    const search = doc.paths['/actions/search']!.post!;
    expect(search.operationId).toBe('search_actions');
    expect(search.security!).toEqual([{ bearerAuth: [] }]);
    expect(search.requestBody!.content['application/json']!.schema).toEqual({
      type: 'object',
      additionalProperties: false,
      properties: { query: { type: 'string', minLength: 1 } },
      required: ['query'],
    });
    expect(search.responses['200']!.content!['application/json']!.schema).toEqual({
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string' },
        actions: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              name: { type: 'string' },
              description: { type: 'string' },
              effects: { type: 'string' },
              provider: {
                type: 'string',
                description:
                  "The action's provider scope (ADR-0013): present on provider-native " +
                  'actions only; canonical actions omit the key.',
                enum: ['feishu', 'dingtalk'],
              },
              deprecated: {
                type: 'object',
                description:
                  "The action's deprecation status (ADR-0014): present on " +
                  'deprecated actions only; non-deprecated actions omit the key.',
                additionalProperties: false,
                properties: {
                  replacement: { type: 'string' },
                  sunset: { type: 'string', format: 'date' },
                  note: { type: 'string' },
                },
              },
            },
            required: ['name', 'description', 'effects'],
          },
        },
      },
      required: ['query', 'actions'],
    });
  });

  it('declares the Bearer security scheme', () => {
    expect(doc.components.securitySchemes.bearerAuth).toMatchObject({
      type: 'http',
      scheme: 'bearer',
    });
  });

  it('publishes every visible action as <name>_input and <name>_output components', () => {
    const visible = PLATFORM_ACTIONS.filter((action) => action.hidden !== true);
    expect(Object.keys(doc.components.schemas).sort()).toEqual(
      ['ActionError', ...visible.flatMap((action) => [`${action.name}_input`, `${action.name}_output`])].sort(),
    );
  });

  it('embeds non-nullable schemas verbatim', () => {
    const getContent = PLATFORM_ACTIONS.find((action) => action.name === 'get_doc_content')!;
    expect(doc.components.schemas.get_doc_content_input).toEqual(getContent.inputSchema);
    // No v1 output schema uses ajv `nullable` (the list cursor is the
    // anyOf form), so every output component must be byte-identical.
    for (const action of PLATFORM_ACTIONS) {
      if (action.hidden) continue;
      expect(doc.components.schemas[`${action.name}_output`]).toEqual(action.outputSchema);
    }
  });

  it('never mutates the registry schemas', () => {
    const snapshot = JSON.stringify(PLATFORM_ACTIONS);
    buildOpenApiDocument(PLATFORM_ACTIONS, META);
    expect(JSON.stringify(PLATFORM_ACTIONS)).toBe(snapshot);
  });

  it('translates nullable: true fields to JSON Schema 2020-12 type arrays', () => {
    const createDocInput = doc.components.schemas.create_doc_input as {
      additionalProperties: boolean;
      properties: Record<string, unknown>;
    };
    expect(createDocInput.additionalProperties).toBe(false);
    expect(createDocInput.properties.folder_id).toEqual({ type: ['string', 'null'] });
    expect(createDocInput.properties.content).toEqual({ type: ['string', 'null'] });

    const searchDocsInput = doc.components.schemas.search_docs_input as {
      properties: Record<string, unknown>;
    };
    // format-free keywords around the nullable field are preserved.
    expect(searchDocsInput.properties.query).toEqual({ type: 'string', minLength: 1 });
    expect(searchDocsInput.properties.limit).toEqual({
      type: ['integer', 'null'],
      minimum: 1,
      maximum: 100,
    });

    const readSheetInput = doc.components.schemas.read_sheet_cells_input as {
      properties: Record<string, unknown>;
    };
    expect(readSheetInput.properties.sheet_name).toEqual({ type: ['string', 'null'], minLength: 1 });

    const writeSheetInput = doc.components.schemas.write_sheet_cells_input as {
      properties: Record<string, unknown>;
    };
    expect(writeSheetInput.properties.sheet_name).toEqual({ type: ['string', 'null'], minLength: 1 });

    const bitableInput = doc.components.schemas.feishu_read_bitable_records_input as {
      properties: Record<string, unknown>;
    };
    expect(bitableInput.properties.limit).toEqual({ type: ['integer', 'null'], minimum: 1, maximum: 100 });
  });

  it('leaves already-2020-12 nullable forms untouched (the anyOf next cursor)', () => {
    const searchDocsOutput = doc.components.schemas.search_docs_output as {
      properties: Record<string, unknown>;
    };
    expect(searchDocsOutput.properties.next).toEqual({
      anyOf: [{ type: 'string' }, { type: 'null' }],
    });
  });

  it('preserves format keywords through the translation', () => {
    const formatAction: Action = {
      name: 'format_probe',
      description: 'Pins format preservation.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: { since: { type: 'string', format: 'date-time', nullable: true } },
        required: [],
      },
      outputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {},
        required: [],
      },
      effects: 'read',
    };
    const probe = buildOpenApiDocument([formatAction], META);
    expect(probe.components.schemas.format_probe_input).toEqual({
      type: 'object',
      additionalProperties: false,
      properties: { since: { type: ['string', 'null'], format: 'date-time' } },
      required: [],
    });
  });

  it('hidden actions never appear anywhere in the document', () => {
    const withoutHidden = buildOpenApiDocument([...PLATFORM_ACTIONS, HIDDEN_ACTION], META);
    expect(Object.keys(withoutHidden.components.schemas)).not.toContain('platform_internal_input');
    expect(Object.keys(withoutHidden.components.schemas)).not.toContain('platform_internal_output');
    expect(JSON.stringify(withoutHidden)).not.toContain('platform_internal');
  });
});

/**
 * The unified error contract (T25): one reusable `ActionError` component
 * (the ADR-0005 shape) referenced by the RPC operation's 4xx/5xx
 * responses, with the 429 response declaring `Retry-After`. The statuses
 * come from the existing `STATUS_BY_ERROR_CODE` mapping (reused, not
 * duplicated) — the RPC path is the only operation that serves the
 * ActionError vocabulary (the discovery paths answer plain `{error}`
 * transport bodies, never ActionErrorJson).
 */
describe('buildOpenApiDocument error contract (T25)', () => {
  const doc = buildOpenApiDocument(PLATFORM_ACTIONS, META);

  it('defines one ActionError component with the ADR-0005 shape', () => {
    const component = doc.components.schemas.ActionError as {
      additionalProperties: boolean;
      required: string[];
      properties: Record<string, unknown>;
    };
    expect(component).toBeDefined();
    expect(component.additionalProperties).toBe(false);
    expect(component.required).toEqual(['code', 'message', 'retryable']);
    expect((component.properties.code as { type: string }).type).toBe('string');
    expect((component.properties.code as { enum: string[] }).enum).toEqual([
      'validation_error',
      'action_not_found',
      'forbidden',
      'auth_expired',
      'not_found',
      'rate_limited',
      'upstream_error',
    ]);
    expect(component.properties.message).toMatchObject({ type: 'string' });
    expect(component.properties.retryable).toMatchObject({ type: 'boolean' });
    expect(
      typeof (component.properties.message as { description?: string }).description,
    ).toBe('string');
    expect(
      typeof (component.properties.retryable as { description?: string }).description,
    ).toBe('string');
    // Optional fields per the ADR-0005 wire shape (errors.ts ActionErrorJson).
    expect(component.properties.retryAfterSeconds).toMatchObject({ type: 'integer', minimum: 0 });
    expect(component.properties.upstream).toMatchObject({
      type: 'object',
      additionalProperties: false,
      properties: {
        code: { type: 'string' },
        message: { type: 'string' },
      },
      required: ['code', 'message'],
    });
    expect(component.properties.details).toBeDefined();
  });

  it('gives the RPC operation one ActionError response per unique STATUS_BY_ERROR_CODE status, via $ref', () => {
    const rpc = doc.paths['/actions/rpc']!.post!;
    const errorStatuses = Object.keys(rpc.responses).filter((status) => status !== '200').sort();
    // The unique statuses of the existing mapping (STATUS_BY_ERROR_CODE),
    // numerically ordered: 400 validation, 401 auth, 403 forbidden, 404
    // not found, 429 rate limit, 502 upstream.
    expect(errorStatuses).toEqual(['400', '401', '403', '404', '429', '502']);
    for (const status of errorStatuses) {
      // Reused, not duplicated: every error response references the shared
      // component instead of inlining a copy.
      expect(rpc.responses[status]!.content!['application/json']!.schema).toEqual({
        $ref: '#/components/schemas/ActionError',
      });
    }
  });

  it('declares the Retry-After header on the 429 response', () => {
    const rpc = doc.paths['/actions/rpc']!.post!;
    const retryAfter = rpc.responses['429']!.headers!['Retry-After'];
    expect(retryAfter).toBeDefined();
    expect(retryAfter!.schema).toEqual({ type: 'string' });
  });
});

describe('GET /openapi.json (T24, HTTP boundary)', () => {
  let server: ServerType;
  let baseUrl: string;

  beforeAll(async () => {
    const app = createOpenApiApp({ actions: PLATFORM_ACTIONS, meta: META });
    server = serve({ fetch: app.fetch, port: 0 });
    await new Promise((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it('serves the generated document at /openapi.json without authentication', async () => {
    const response = await fetch(`${baseUrl}/openapi.json`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/^application\/json/);
    const body = (await response.json()) as OpenApiDocument;
    expect(body).toEqual(buildOpenApiDocument(PLATFORM_ACTIONS, META));
  });

  it('ignores auth headers entirely (platform-level contract metadata)', async () => {
    const response = await fetch(`${baseUrl}/openapi.json`, {
      headers: { authorization: 'Bearer totally-bogus' },
    });
    expect(response.status).toBe(200);
    expect((await response.json()) as OpenApiDocument).toEqual(
      buildOpenApiDocument(PLATFORM_ACTIONS, META),
    );
  });
});
