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
  /**
   * Auth header carrying the token (Feishu: Authorization, DingTalk:
   * x-acs-dingtalk-access-token). Optional — a family that authenticates
   * by query param (#48, WeCom) or a pre-auth endpoint (gettoken) sets
   * neither this nor `tokenQueryName` and no auth is attached.
   */
  authHeaderName?: string;
  /**
   * Query-param auth (#48): when set, the token rides the URL as this
   * query parameter (WeCom: ?access_token=…) and NO auth header is sent —
   * the token never double-attaches. Mutually exclusive in effect with
   * `authHeaderName`: whichever is set wins, query taking precedence.
   */
  tokenQueryName?: string;
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
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  token?: string;
  query?: Record<string, string>;
  body?: unknown;
}

/** One upstream request: endpoint path + options → payload. */
export type UpstreamRequest = <T>(path: string, opts?: UpstreamRequestOptions) => Promise<T>;

/** A downloaded artifact: raw bytes plus the upstream content type. */
export interface DownloadedFile {
  bytes: Uint8Array;
  contentType: string | undefined;
}

export interface UpstreamDownloadOptions {
  token?: string;
  /**
   * Raw-byte ceiling for the artifact: a content-length precheck rejects
   * announced oversize before the body is read; the post-read check
   * catches a lying header. Over-cap → `upstream_error` (not retryable —
   * the artifact will not shrink).
   */
  maxBytes?: number;
}

/**
 * The kernel's callable: one JSON request stack plus the binary download
 * stack. Structurally assignable to plain `UpstreamRequest`, so existing
 * connector fields and helpers keep their types.
 */
export interface UpstreamHttp {
  <T>(path: string, opts?: UpstreamRequestOptions): Promise<T>;
  /**
   * Binary download (`get_export_artifact`). A relative path builds on
   * `baseUrl` and carries the profile's auth (header, or query param for
   * query-token families — WeCom media). An absolute http(s) URL is
   * fetched verbatim with NO auth of any kind — pre-signed links (DingTalk
   * export downloadUrl) must never leak the connection's token to a
   * third-party host. Non-2xx failures map through the profile's
   * `handleResponse` (error bodies are JSON even when success is binary).
   */
  download(pathOrUrl: string, opts?: UpstreamDownloadOptions): Promise<DownloadedFile>;
}

export function createUpstreamHttp(profile: UpstreamHttpProfile): UpstreamHttp {
  const fetchImpl = profile.fetchImpl ?? fetch;
  const tokenPrefix = profile.tokenPrefix ?? '';

  /** Where the token goes for this profile: query param, auth header, or nowhere. */
  const authHeaders = (token: string | undefined): Record<string, string> =>
    profile.authHeaderName === undefined || profile.tokenQueryName !== undefined
      ? {}
      : { [profile.authHeaderName]: `${tokenPrefix}${token ?? ''}` };

  const request = async <T>(path: string, opts: UpstreamRequestOptions = {}): Promise<T> => {
    const url = new URL(`${profile.baseUrl}${path}`);
    for (const [key, value] of Object.entries(opts.query ?? {})) {
      url.searchParams.set(key, value);
    }
    // Query-param auth (#48): the token rides the URL AFTER the caller's
    // own query params, and the header stack stays empty.
    if (profile.tokenQueryName !== undefined && opts.token !== undefined) {
      url.searchParams.set(profile.tokenQueryName, opts.token);
    }

    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: opts.method ?? 'GET',
        headers: {
          ...authHeaders(opts.token),
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

  const download = async (
    pathOrUrl: string,
    opts: UpstreamDownloadOptions = {},
  ): Promise<DownloadedFile> => {
    const absolute = /^https?:\/\//i.test(pathOrUrl);
    const url = absolute ? new URL(pathOrUrl) : new URL(`${profile.baseUrl}${pathOrUrl}`);
    if (!absolute && profile.tokenQueryName !== undefined && opts.token !== undefined) {
      url.searchParams.set(profile.tokenQueryName, opts.token);
    }

    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: 'GET',
        headers: absolute ? {} : authHeaders(opts.token),
      });
    } catch (err) {
      throw new ActionError(
        'upstream_error',
        `${profile.label} unreachable: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (!response.ok) {
      // Error bodies are JSON envelopes even when success is binary; map
      // through the profile so the failure keeps its vocabulary code.
      const text = await response.text();
      let body: unknown;
      try {
        body = text === '' ? undefined : JSON.parse(text);
      } catch {
        body = undefined;
      }
      profile.handleResponse(response, body);
      // A profile that declines to throw on a failure status still failed.
      throw new ActionError(
        'upstream_error',
        `${profile.label} download failed (HTTP ${response.status})`,
      );
    }

    const capError = (size: number): ActionError =>
      new ActionError(
        'upstream_error',
        `${profile.label} artifact exceeds the download cap: ${size} bytes (cap ${opts.maxBytes})`,
      );
    const declared = Number(response.headers.get('content-length'));
    if (opts.maxBytes !== undefined && Number.isFinite(declared) && declared > opts.maxBytes) {
      throw capError(declared);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    const contentType = response.headers.get('content-type') ?? undefined;
    // Envelope-convention profiles (Feishu) report failures as HTTP 200
    // JSON envelopes — the status lies. A JSON body on a download is an
    // error envelope, never the artifact: map it through the profile, and
    // only bytes that survive the envelope check are returned.
    if (contentType?.toLowerCase().includes('application/json')) {
      try {
        const body: unknown = JSON.parse(new TextDecoder().decode(bytes));
        if (body !== null && typeof body === 'object') {
          profile.handleResponse(response, body);
        }
      } catch (err) {
        if (err instanceof ActionError) throw err;
        // Unparseable JSON: treat the bytes as the artifact.
      }
    }
    if (opts.maxBytes !== undefined && bytes.byteLength > opts.maxBytes) {
      throw capError(bytes.byteLength);
    }
    return { bytes, contentType };
  };

  const http = request as UpstreamHttp;
  http.download = download;
  return http;
}
