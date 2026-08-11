import type { ActionContext, ActionHandler } from '../action.js';
import type { TestConnectionOutput } from '../actions.js';
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
 * T17a ships the connection skeleton only: `test_connection`, which proves
 * the Connection's token against the cheapest call in DingTalk's proven
 * scope (the identity API `GET /v1.0/contact/users/me`, which needs only
 * the `openid` scope). Doc actions land in T17b/T17c and extend the
 * manifest.
 */
export class DingTalkConnector implements IConnector {
  readonly manifest = {
    id: 'dingtalk_docs',
    implements: ['test_connection'],
    // DingTalk's real per-account limits are confirmed during the T17b
    // live pass; until then the platform default applies (undeclared).
  };

  private readonly handlers: Record<string, ActionHandler>;

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
    };
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
