import { describe, expect, it } from 'vitest';
import { ActionError } from '../src/errors.js';
import { createUpstreamHttp, type UpstreamHttpProfile } from '../src/upstream-http.js';

/**
 * The Upstream HTTP Kernel (CONTEXT.md): the request machinery the
 * connectors share — URL + query building, fetch, network and non-JSON
 * failures, the empty-body policy — with each connector family
 * contributing a profile (label, auth header, response handling). This
 * suite drives the kernel through a fake fetch; the connector suites at
 * Seam B stay the wire-behaviour regression guard.
 */

interface Captured {
  url: URL;
  init: RequestInit;
}

function fakeFetch(handler: (input: URL, init: RequestInit) => Response | Promise<Response>) {
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    const url = input instanceof URL ? input : new URL(typeof input === 'string' ? input : input.url);
    return handler(url, init ?? {});
  }) as typeof fetch;
}

function profile(overrides: Partial<UpstreamHttpProfile> & { fetchImpl: typeof fetch }): UpstreamHttpProfile {
  return {
    baseUrl: 'https://api.example.com',
    label: 'Example API',
    authHeaderName: 'authorization',
    allowEmptyBody: false,
    handleResponse: () => ({}),
    ...overrides,
  };
}

describe('createUpstreamHttp (the shared request stack)', () => {
  it('builds the URL from baseUrl + path and encodes query params', async () => {
    const captured: Captured[] = [];
    const request = createUpstreamHttp(
      profile({
        fetchImpl: fakeFetch((url, init) => {
          captured.push({ url, init });
          return new Response('{}', { status: 200 });
        }),
      }),
    );

    await request('/open-apis/x/y', { query: { a: 'b c', d: '1' } });

    expect(captured).toHaveLength(1);
    expect(captured[0]!.url.toString()).toBe('https://api.example.com/open-apis/x/y?a=b+c&d=1');
  });

  it('sends the method, auth header with prefix, JSON content-type and stringified body', async () => {
    const captured: Captured[] = [];
    const request = createUpstreamHttp(
      profile({
        tokenPrefix: 'Bearer ',
        fetchImpl: fakeFetch((url, init) => {
          captured.push({ url, init });
          return new Response('{}', { status: 200 });
        }),
      }),
    );

    await request('/x', { method: 'POST', token: 'tok-1', body: { n: 1 } });

    expect(captured[0]!.init.method).toBe('POST');
    expect(captured[0]!.init.headers).toEqual({
      authorization: 'Bearer tok-1',
      'content-type': 'application/json',
    });
    expect(captured[0]!.init.body).toBe(JSON.stringify({ n: 1 }));
  });

  it('defaults to GET with no content-type or body', async () => {
    const captured: Captured[] = [];
    const request = createUpstreamHttp(
      profile({
        fetchImpl: fakeFetch((url, init) => {
          captured.push({ url, init });
          return new Response('{}', { status: 200 });
        }),
      }),
    );

    await request('/x');

    expect(captured[0]!.init.method).toBe('GET');
    expect(captured[0]!.init.body).toBeUndefined();
    expect(captured[0]!.init.headers).toEqual({ authorization: '' });
  });

  it('throws upstream_error when the fetch rejects (network failure)', async () => {
    const request = createUpstreamHttp(
      profile({
        fetchImpl: fakeFetch(() => {
          throw new Error('connection refused');
        }),
      }),
    );

    await expect(request('/x')).rejects.toMatchObject({
      code: 'upstream_error',
      message: 'Example API unreachable: connection refused',
    });
  });

  it('throws upstream_error on non-JSON bodies', async () => {
    const request = createUpstreamHttp(
      profile({
        fetchImpl: fakeFetch(() => new Response('<html>oops</html>', { status: 502 })),
      }),
    );

    await expect(request('/x')).rejects.toMatchObject({
      code: 'upstream_error',
      message: 'Example API returned non-JSON (HTTP 502)',
    });
  });

  it('treats an empty body as non-JSON when allowEmptyBody is false', async () => {
    const request = createUpstreamHttp(
      profile({
        allowEmptyBody: false,
        fetchImpl: fakeFetch(() => new Response('', { status: 200 })),
      }),
    );

    await expect(request('/x')).rejects.toMatchObject({
      code: 'upstream_error',
      message: 'Example API returned non-JSON (HTTP 200)',
    });
  });

  it('passes an undefined body to handleResponse when allowEmptyBody is true', async () => {
    let seenBody: unknown = 'sentinel';
    const request = createUpstreamHttp(
      profile({
        allowEmptyBody: true,
        handleResponse: (_response, body) => {
          seenBody = body;
          return { ok: true };
        },
        fetchImpl: fakeFetch(() => new Response('', { status: 200 })),
      }),
    );

    await expect(request('/x')).resolves.toEqual({ ok: true });
    expect(seenBody).toBeUndefined();
  });

  it('returns the handleResponse payload unchanged', async () => {
    const payload = { data: { items: [1, 2] } };
    const request = createUpstreamHttp(
      profile({
        handleResponse: () => payload,
        fetchImpl: fakeFetch(() => new Response('{"code":0}', { status: 200 })),
      }),
    );

    await expect(request<typeof payload>('/x')).resolves.toBe(payload);
  });

  it('propagates the ActionError thrown by handleResponse', async () => {
    const request = createUpstreamHttp(
      profile({
        handleResponse: () => {
          throw new ActionError('rate_limited', 'Example rate limited');
        },
        fetchImpl: fakeFetch(() => new Response('{"code":999914}', { status: 200 })),
      }),
    );

    await expect(request('/x')).rejects.toMatchObject({
      code: 'rate_limited',
      message: 'Example rate limited',
    });
  });
});
