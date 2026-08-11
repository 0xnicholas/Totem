import type { ActionContext, ActionHandler } from '../action.js';
import type {
  GetDocContentInput,
  GetDocContentOutput,
  GetDocMetadataInput,
  GetDocMetadataOutput,
  SearchDocsInput,
  SearchDocsOutput,
  TestConnectionOutput,
} from '../actions.js';
import type { IConnector } from '../connector.js';
import { ActionError } from '../errors.js';
import { DingTalkApiError } from './oauth.js';

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
 * DingTalk errors → the unified vocabulary. It receives an already-valid
 * user access token in `ActionContext.token` (ADR-0004) and never touches
 * the database, governance, or config stores.
 *
 * T17a shipped the connection skeleton: `test_connection`, which proves
 * the Connection's token against the cheapest call in DingTalk's proven
 * scope (the identity API `GET /v1.0/contact/users/me`, which needs only
 * the `openid` scope). T17b adds the read subset — `search_docs` (via
 * `POST /v2.0/storage/dentries/search`), `get_doc_content` and
 * `get_doc_metadata` (via the doc family `GET
 * /v1.0/doc/suites/documents/{docKey}[ /content]`) — over DingTalk's
 * online documents (ALIDOC). Sheets/workbooks stay out of the manifest
 * until a faithful translation lands (T17c decision point).
 *
 * Live-shape notes (T17b AC-7 pending): the doc endpoints below are
 * modeled on the published API docs; the live pass with a real DingTalk
 * account corrects any drift (the Feishu connector's T9 pass corrected
 * several mock-modeled shapes).
 */
export class DingTalkConnector implements IConnector {
  readonly manifest = {
    id: 'dingtalk_docs',
    implements: ['test_connection', 'search_docs', 'get_doc_content', 'get_doc_metadata'],
    // Conservative comfort level (120/min = 2 QPS average) until the T17b
    // live pass confirms DingTalk's real per-API limits; the boundary
    // throttles per (tenant, connection) to this.
    rateLimit: { requestsPerMinute: 120 },
  };

  private readonly handlers: Record<string, ActionHandler>;
  /**
   * DingTalk's v2.0 doc APIs require the acting user's `unionId` as
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

  constructor(private readonly apiBaseUrl: string) {
    this.handlers = {
      test_connection: async (_args, ctx) => {
        // The cheapest call in the connector's proven scope: the identity
        // API succeeds iff the connection's user access token is valid and
        // API access works. The token manager has already refreshed an
        // expiring token (ADR-0004), so this call is the live proof.
        await dingtalkRequest(this.apiBaseUrl, '/v1.0/contact/users/me', {
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
        const response = await this.docRequest<DentriesResponse>(
          '/v2.0/storage/dentries/search',
          {
            method: 'POST',
            body: {
              keyword: input.query,
              option: { maxResults: input.limit ?? 50 },
            },
          },
          ctx,
        );
        // v1 read scope: online documents (ALIDOC) only — the platform's
        // doc actions address documents, not the broader file store (which
        // the search API also returns: uploaded files, images, archives).
        // Matches beyond DingTalk's page cap (maxResults ≤ 50) are
        // truncated; cursor semantics are v2 per ADR-0012.
        const output: SearchDocsOutput = {
          data: response.dentries
            .filter((dentry) => dentry.contentType === 'alidoc')
            .map((dentry) => ({
              doc_id: dentry.docKey,
              title: dentry.name,
              doc_type: DingTalkConnector.DOC_TYPE_ONLINE_DOC,
            })),
          next: null,
        };
        return output;
      },

      get_doc_content: async (args: GetDocContentInput, ctx) => {
        const input = args;
        const response = await this.docRequest<{ content: string }>(
          `/v1.0/doc/suites/documents/${encodeURIComponent(input.doc_id)}/content`,
          {},
          ctx,
        );
        const output: GetDocContentOutput = {
          doc_id: input.doc_id,
          content: response.content,
        };
        return output;
      },

      get_doc_metadata: async (args: GetDocMetadataInput, ctx) => {
        const input = args;
        const response = await this.docRequest<DentryResponse>(
          `/v1.0/doc/suites/documents/${encodeURIComponent(input.doc_id)}`,
          {},
          ctx,
        );
        const output: GetDocMetadataOutput = {
          doc_id: input.doc_id,
          title: response.name,
          owner_id: response.creator.unionId,
          doc_type: DingTalkConnector.DOC_TYPE_ONLINE_DOC,
          // DingTalk timestamps are epoch-millisecond Longs (occasionally
          // serialized as strings); the platform contract promises an ISO
          // timestamp.
          edited_at: toIsoMillis(response.updatedTime),
        };
        return output;
      },
    };
  }

  /**
   * One doc-family call with the acting user's `operatorId` attached.
   * A rejected token drops the cached unionId (the connection's identity
   * may have changed on re-authorization) and rethrows, so the caller
   * sees `auth_expired` (the token manager marks the connection and
   * fail-fast afterwards).
   */
  private async docRequest<T>(
    path: string,
    opts: { method?: 'GET' | 'POST'; body?: unknown },
    ctx: ActionContext,
  ): Promise<T> {
    const operatorId = await this.resolveUnionId(ctx.connectionId, ctx.token);
    try {
      return await dingtalkRequest<T>(this.apiBaseUrl, path, {
        method: opts.method,
        token: ctx.token,
        query: { operatorId },
        body: opts.body,
      });
    } catch (err) {
      if (err instanceof ActionError && err.code === 'auth_expired') {
        this.unionIds.delete(ctx.connectionId);
      }
      throw err;
    }
  }

  /**
   * Resolves the acting user's unionId (DingTalk's `operatorId`), cached
   * per connection. The identity call only runs on a cache miss.
   */
  private async resolveUnionId(connectionId: string, token: string | undefined): Promise<string> {
    const cached = this.unionIds.get(connectionId);
    if (cached) return cached;
    const me = await dingtalkRequest<{ unionId: string }>(
      this.apiBaseUrl,
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

/** A dentry in a search response / doc-info response (T17b modeled shapes). */
interface DentryResponse {
  dentryId: string;
  docKey: string;
  name: string;
  contentType: string;
  url: string;
  createdTime: number | string;
  updatedTime: number | string;
  creator: { unionId: string; name: string };
}

/**
 * Normalizes an epoch-millisecond Long (number or numeric string) to ISO.
 * A missing or non-numeric value is an upstream contract break — the
 * platform output schema requires edited_at — so it fails loudly as an
 * upstream_error instead of a raw RangeError.
 */
function toIsoMillis(value: number | string | undefined): string {
  const millis = typeof value === 'string' ? Number(value) : value;
  if (millis === undefined || !Number.isFinite(millis)) {
    throw new ActionError(
      'upstream_error',
      `DingTalk document info omitted a valid updatedTime (got ${String(value)})`,
    );
  }
  return new Date(millis).toISOString();
}

interface DentriesResponse {
  dentries: DentryResponse[];
  nextToken: string;
}

/**
 * One DingTalk Open Platform API call: `x-acs-dingtalk-access-token` auth,
 * JSON body parsing, and vocabulary mapping of every failure. Network and
 * non-JSON failures are upstream errors — DingTalk told us nothing.
 */
async function dingtalkRequest<T>(
  baseUrl: string,
  path: string,
  opts: { method?: 'GET' | 'POST'; token?: string; query?: Record<string, string>; body?: unknown },
): Promise<T> {
  const url = new URL(`${baseUrl}${path}`);
  for (const [key, value] of Object.entries(opts.query ?? {})) {
    url.searchParams.set(key, value);
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method: opts.method ?? 'GET',
      headers: {
        'x-acs-dingtalk-access-token': opts.token ?? '',
        ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
  } catch (err) {
    throw new ActionError(
      'upstream_error',
      `DingTalk API unreachable: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let body: unknown;
  let rawBody = '';
  try {
    rawBody = await response.text();
    body = rawBody === '' ? undefined : JSON.parse(rawBody);
  } catch {
    throw new ActionError(
      'upstream_error',
      `DingTalk API returned non-JSON (HTTP ${response.status})`,
    );
  }

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
  return body as T;
}
