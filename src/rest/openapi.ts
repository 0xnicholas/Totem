import { Hono } from 'hono';
import type { AnySchemaObject } from 'ajv';
import type { Action } from '../action.js';
import { ACTION_ERROR_CODES, type ActionErrorCode } from '../errors.js';
import { TOTEM_VERSION } from '../version.js';
import { STATUS_BY_ERROR_CODE } from './rpc.js';

/** The document-level metadata injected by the composition root (T24). */
export interface OpenApiMeta {
  /**
   * The totem release version (TOTEM_VERSION) — mirrored verbatim into
   * `info.version` so consumers can machine-read contract evolution.
   */
  version: string;
  /** The platform's display name. */
  title: string;
  /** The public base URL of this deployment (the operator's TOTEM_URL). */
  serverUrl: string;
}

export interface OpenApiAppConfig {
  /** The platform action set (the registry's view; hidden actions are filtered here). */
  actions: Action[];
  meta: OpenApiMeta;
}

/**
 * The platform's canonical document meta (T26): the composition root serves
 * this by default, and the committed snapshot (`openapi.json`) is generated
 * from it — so the snapshot and the default-served document can never
 * disagree. An operator overriding TOTEM_URL changes only `serverUrl`.
 */
export const DEFAULT_OPENAPI_META: OpenApiMeta = {
  version: TOTEM_VERSION,
  title: 'Totem API',
  serverUrl: 'http://localhost:3000',
};

export interface Parameter {
  name: string;
  in: string;
  required?: boolean;
  description?: string;
  schema: unknown;
}

export interface RequestBody {
  description?: string;
  required?: boolean;
  content: Record<string, { schema: unknown }>;
}

export interface Response {
  description: string;
  content?: Record<string, { schema: unknown }>;
  headers?: Record<string, { description?: string; schema: unknown }>;
}

export interface Operation {
  operationId: string;
  description?: string;
  security?: Array<Record<string, string[]>>;
  parameters?: Parameter[];
  requestBody?: RequestBody;
  responses: Record<string, Response>;
}

export interface PathItem {
  get?: Operation;
  post?: Operation;
}

/** The generated contract (OpenAPI 3.1, JSON Schema 2020-12). */
export interface OpenApiDocument {
  openapi: '3.1.0';
  info: { title: string; version: string; description?: string };
  servers: Array<{ url: string }>;
  paths: Record<string, PathItem>;
  components: {
    securitySchemes: Record<string, unknown>;
    schemas: Record<string, unknown>;
  };
}

const BEARER_SECURITY = [{ bearerAuth: [] }];

/**
 * The RPC envelope (ADR-0008): `{action, args}` — `args` is the same flat
 * object MCP `tools/call` receives (the registry's input schema), so the
 * two consumption surfaces can never diverge in parameter shape.
 */
const rpcEnvelopeSchema = {
  type: 'object',
  properties: {
    action: { type: 'string' },
    args: { type: 'object' },
  },
  required: ['action'],
} as const;

const actionMetadataSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string' },
    description: { type: 'string' },
    effects: { type: 'string' },
  },
  required: ['name', 'description', 'effects'],
} as const;

const actionsListSchema = {
  type: 'object',
  additionalProperties: false,
  properties: { actions: { type: 'array', items: actionMetadataSchema } },
  required: ['actions'],
} as const;

const searchBodySchema = {
  type: 'object',
  additionalProperties: false,
  properties: { query: { type: 'string', minLength: 1 } },
  required: ['query'],
} as const;

const searchOkSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    query: { type: 'string' },
    actions: { type: 'array', items: actionMetadataSchema },
  },
  required: ['query', 'actions'],
} as const;

const connectionIdParameter: Parameter = {
  name: 'x-connection-id',
  in: 'header',
  required: true,
  description:
    'The connection to execute the action against — the same per-request ' +
    'connection addressing the MCP surface performs.',
  schema: { type: 'string' },
};

/**
 * The unified error vocabulary as a component (T25, ADR-0005): the
 * `ActionErrorJson` wire shape from errors.ts — seven `code` values (the
 * registry's `ACTION_ERROR_CODES`, never re-listed by hand), `message`,
 * `retryable`, plus the optional `retryAfterSeconds` (T13), `upstream`
 * diagnostics and `details`.
 */
const actionErrorSchema = {
  type: 'object',
  additionalProperties: false,
  description:
    'The unified error vocabulary (ADR-0005): seven codes, each with a ' +
    'retryable flag — agents retry when retryable, stop otherwise.',
  properties: {
    code: {
      type: 'string',
      description: 'One of the seven ADR-0005 codes.',
      enum: [...ACTION_ERROR_CODES],
    },
    message: { type: 'string', description: 'Human-readable failure description.' },
    retryable: {
      type: 'boolean',
      description: 'Whether an agent should retry this action (false for validation and permission errors).',
    },
    retryAfterSeconds: {
      type: 'integer',
      minimum: 0,
      description: 'Whole seconds to wait before retrying; present on platform-issued rate_limited (T13).',
    },
    upstream: {
      type: 'object',
      additionalProperties: false,
      description: 'The original upstream error, for diagnostics.',
      properties: {
        code: { type: 'string' },
        message: { type: 'string' },
      },
      required: ['code', 'message'],
    },
    details: {
      description: 'Extra context — e.g. the ValidationIssue[] list on validation_error.',
    },
  },
  required: ['code', 'message', 'retryable'],
} as const;

/**
 * The unique HTTP statuses of the existing status mapping (T14), derived
 * — never re-listed — from `STATUS_BY_ERROR_CODE`, numerically ordered so
 * the generated document is deterministic.
 */
const ACTION_ERROR_STATUSES = [...new Set(Object.values(STATUS_BY_ERROR_CODE))].sort(
  (a, b) => a - b,
);

/** The codes served at each status (for the response descriptions). */
const CODES_BY_STATUS: Record<number, ActionErrorCode[]> = {};
for (const [code, status] of Object.entries(STATUS_BY_ERROR_CODE)) {
  const codes = CODES_BY_STATUS[status] ?? [];
  codes.push(code as ActionErrorCode);
  CODES_BY_STATUS[status] = codes;
}

/** Every ActionError response references the shared component — reused, not duplicated. */
function actionErrorResponse(status: number): Response {
  return {
    description: `ActionError (ADR-0005): ${CODES_BY_STATUS[status]!.join(', ')} — see components.schemas.ActionError.`,
    content: { 'application/json': { schema: { $ref: '#/components/schemas/ActionError' } } },
    ...(status === 429
      ? {
          headers: {
            'Retry-After': {
              description:
                'Whole seconds to wait before retrying (T13) — present on rate_limited errors.',
              schema: { type: 'string' },
            },
          },
        }
      : {}),
  };
}

/**
 * Projection #3 of the action registry (after MCP tools and the RPC
 * envelope, ADR-0008): the machine-readable layer of the Consumption
 * Standard — generated, never hand-maintained. A pure function: no I/O, no
 * app wiring, and the registry's schemas are never mutated.
 *
 * The three REST routes are documented as-is. `POST /actions/rpc` is a
 * single generic envelope operation (`{action, args}` — the RPC path is one
 * endpoint, so per-action contracts are published in `components.schemas`
 * as `<action>_input` / `<action>_output`, embedded verbatim with exactly
 * one permitted transformation: the ajv draft-07 `nullable: true` →
 * JSON Schema 2020-12 `type: [...]` translation). Hidden actions are
 * filtered before generation (the discovery rule: `hidden !== true`), so
 * platform-internal actions never appear.
 */
export function buildOpenApiDocument(actions: Action[], meta: OpenApiMeta): OpenApiDocument {
  const visible = actions
    .filter((action) => action.hidden !== true)
    .sort((a, b) => a.name.localeCompare(b.name));

  const schemas: Record<string, unknown> = { ActionError: actionErrorSchema };
  for (const action of visible) {
    schemas[`${action.name}_input`] = toOpenApiSchema(action.inputSchema);
    schemas[`${action.name}_output`] = toOpenApiSchema(action.outputSchema);
  }

  const errorResponses: Record<string, Response> = {};
  for (const status of ACTION_ERROR_STATUSES) {
    errorResponses[String(status)] = actionErrorResponse(status);
  }

  return {
    openapi: '3.1.0',
    info: {
      title: meta.title,
      version: meta.version,
      description:
        'Totem action layer: schema-first actions over MCP and REST. The registry is ' +
        'the single source of truth; every surface is a projection of it (ADR-0008).',
    },
    servers: [{ url: meta.serverUrl }],
    paths: {
      '/actions': {
        get: {
          operationId: 'list_actions',
          description:
            'List the platform action set as metadata (name, description, effects); ' +
            'hidden actions are excluded.',
          security: BEARER_SECURITY,
          responses: {
            '200': {
              description: 'The platform action set as metadata (hidden excluded).',
              content: { 'application/json': { schema: actionsListSchema } },
            },
          },
        },
      },
      '/actions/search': {
        post: {
          operationId: 'search_actions',
          description:
            'Case-insensitive text search across action names and descriptions ' +
            '(semantic search is v2; substring matching is the documented v1 contract).',
          security: BEARER_SECURITY,
          requestBody: {
            required: true,
            content: { 'application/json': { schema: searchBodySchema } },
          },
          responses: {
            '200': {
              description: 'The matching actions plus the query they matched.',
              content: { 'application/json': { schema: searchOkSchema } },
            },
          },
        },
      },
      '/actions/rpc': {
        post: {
          operationId: 'actions_rpc',
          description:
            "Execute any registered action — the REST projection of the execution " +
            "boundary (same governance, same error vocabulary, same audit as MCP). " +
            "Envelope: {action, args}. Each action's input and output schemas are " +
            "published verbatim in components.schemas as <action>_input and " +
            "<action>_output. Action-level failures return the ActionError body " +
            "(components.schemas.ActionError) with the HTTP status per the ADR-0005 " +
            'mapping; rate_limited responses carry a Retry-After header.',
          security: BEARER_SECURITY,
          parameters: [connectionIdParameter],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: rpcEnvelopeSchema } },
          },
          responses: {
            '200': {
              description:
                "The action's output — see the matching <action>_output component " +
                'in components.schemas.',
              content: { 'application/json': { schema: { type: 'object' } } },
            },
            ...errorResponses,
          },
        },
      },
    },
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          description:
            'Tenant API key (actions scope) — the same key the MCP surface accepts.',
        },
      },
      schemas,
    },
  };
}

/**
 * The platform contract as served and committed (T26): `buildOpenApiDocument`
 * over the v1 platform action set with the canonical `DEFAULT_OPENAPI_META`.
 * The snapshot generator (`scripts/generate-openapi.mts`) and the CI drift
 * gate use exactly this, so a registry change that forgets to update
 * `openapi.json` turns the build red.
 */
export function buildPlatformOpenApiDocument(actions: Action[]): OpenApiDocument {
  return buildOpenApiDocument(actions, DEFAULT_OPENAPI_META);
}

/**
 * The publication surface (T24): serves the generated document at
 * `GET /openapi.json` with NO authentication — platform-level contract
 * metadata (no tenant data; hidden actions already filtered), the same
 * decision StackOne makes for its api-catalog. The document is built once
 * at app creation: the registry is static per process.
 */
export function createOpenApiApp(config: OpenApiAppConfig): Hono {
  const document = buildOpenApiDocument(config.actions, config.meta);
  const app = new Hono();
  app.get('/openapi.json', (c) => c.json(document));
  return app;
}

/**
 * The ajv draft-07 → JSON Schema 2020-12 translation — the one
 * transformation the generator performs (everything else is embedded
 * verbatim): `nullable: true` becomes a `type` array with `'null'`
 * appended, e.g. `{type: 'string', nullable: true}` →
 * `{type: ['string', 'null']}`. `format` keywords, `additionalProperties`
 * and already-2020-12 forms (the list cursor's `anyOf`) pass through
 * untouched. A fresh object graph is produced on every call — the
 * registry's schemas are never mutated.
 */
function toOpenApiSchema(schema: AnySchemaObject): unknown {
  return translate(schema);
}

function translate(node: unknown): unknown {
  if (Array.isArray(node)) return node.map((item) => translate(item));
  if (node !== null && typeof node === 'object') {
    const source = node as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(source)) {
      // `nullable: true` folds into the type array below.
      if (key === 'nullable' && value === true) continue;
      out[key] = translate(value);
    }
    if (source.nullable === true) {
      const type = source.type;
      if (typeof type === 'string') {
        out.type = [type, 'null'];
      } else if (Array.isArray(type) && !type.includes('null')) {
        out.type = [...(type as string[]), 'null'];
      }
      // nullable without a type already means "anything, including null" —
      // no constraint to add.
    }
    return out;
  }
  return node;
}
