import { ActionError } from './errors.js';

/**
 * The Upstream HTTP Kernel (CONTEXT.md): the request machinery the
 * connectors share — URL + query building, fetch, JSON parsing, and the
 * network / non-JSON failure vocabulary — with each connector family
 * contributing a profile: the system label for failure messages, the auth
 * header, the empty-body policy, and the envelope convention (success
 * check + payload unwrap + error mapping) in `handleResponse`. Connectors
 * stay pure translators (ADR-0003); this module is platform plumbing, not
 * a connector capability.
 */
export interface UpstreamHttpProfile {
  baseUrl: string;
  /** System name in failure messages, e.g. "Feishu Docs API". */
  label: string;
  authHeaderName: string;
  /** Prefix prepended to the token in the auth header (Feishu: "Bearer "). */
  tokenPrefix?: string;
  /** Empty 2xx bodies: a valid payload (DingTalk) or a non-JSON failure (Feishu). */
  allowEmptyBody: boolean;
  /**
   * The provider's envelope convention: the success check, payload unwrap,
   * and error mapping. Receives the HTTP response plus the parsed body
   * (`undefined` only when `allowEmptyBody` is true and the body was
   * empty); throws an ActionError on failure and returns the payload on
   * success.
   */
  handleResponse(response: Response, body: unknown): unknown;
  /** Fetch dependency (tests inject a fake; defaults to the global fetch). */
  fetchImpl?: typeof fetch;
}

export interface UpstreamRequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT';
  token?: string;
  query?: Record<string, string>;
  body?: unknown;
}

/** One upstream request: endpoint path + options → payload. */
export type UpstreamRequest = <T>(path: string, opts?: UpstreamRequestOptions) => Promise<T>;

export function createUpstreamHttp(profile: UpstreamHttpProfile): UpstreamRequest {
  const fetchImpl = profile.fetchImpl ?? fetch;
  const tokenPrefix = profile.tokenPrefix ?? '';
  return async <T>(path: string, opts: UpstreamRequestOptions = {}): Promise<T> => {
    const url = new URL(`${profile.baseUrl}${path}`);
    for (const [key, value] of Object.entries(opts.query ?? {})) {
      url.searchParams.set(key, value);
    }

    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: opts.method ?? 'GET',
        headers: {
          [profile.authHeaderName]: `${tokenPrefix}${opts.token ?? ''}`,
          ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      });
    } catch (err) {
      throw new ActionError(
        'upstream_error',
        `${profile.label} unreachable: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    let body: unknown;
    try {
      const rawBody = await response.text();
      if (rawBody === '') {
        if (!profile.allowEmptyBody) {
          throw new ActionError(
            'upstream_error',
            `${profile.label} returned non-JSON (HTTP ${response.status})`,
          );
        }
        body = undefined;
      } else {
        body = JSON.parse(rawBody);
      }
    } catch (err) {
      if (err instanceof ActionError) throw err;
      throw new ActionError(
        'upstream_error',
        `${profile.label} returned non-JSON (HTTP ${response.status})`,
      );
    }

    return profile.handleResponse(response, body) as T;
  };
}
