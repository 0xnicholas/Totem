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

describe('createUpstreamHttp.download (the binary download stack)', () => {
  it('downloads a relative path with the profile auth header, returning bytes and content-type', async () => {
    const captured: Captured[] = [];
    const http = createUpstreamHttp(
      profile({
        tokenPrefix: 'Bearer ',
        fetchImpl: fakeFetch((url, init) => {
          captured.push({ url, init });
          return new Response('%PDF-1.4', {
            status: 200,
            headers: { 'content-type': 'application/pdf' },
          });
        }),
      }),
    );

    const file = await http.download('/open-apis/drive/v1/medias/tok-9/download', {
      token: 'user-token',
    });

    expect(captured[0]!.url.toString()).toBe('https://api.example.com/open-apis/drive/v1/medias/tok-9/download');
    expect(captured[0]!.init.method).toBe('GET');
    expect(captured[0]!.init.headers).toEqual({ authorization: 'Bearer user-token' });
    expect(Buffer.from(file.bytes).toString('utf8')).toBe('%PDF-1.4');
    expect(file.contentType).toBe('application/pdf');
  });

  it('downloads an absolute URL verbatim with NO auth header (presigned links never see the token)', async () => {
    const captured: Captured[] = [];
    const http = createUpstreamHttp(
      profile({
        fetchImpl: fakeFetch((url, init) => {
          captured.push({ url, init });
          // Typed-array body: undici sets no default content-type.
          return new Response(new Uint8Array([98, 121, 116, 101, 115]), { status: 200 });
        }),
      }),
    );

    const file = await http.download('https://files.other-host.example/export/job-1?sig=abc');

    expect(captured[0]!.url.toString()).toBe('https://files.other-host.example/export/job-1?sig=abc');
    expect(captured[0]!.init.headers).toEqual({});
    expect(file.bytes.byteLength).toBe(5);
    // A typed-array body sets no default content-type: absent stays absent.
    expect(file.contentType).toBeUndefined();
  });

  it('maps a non-2xx download failure through the profile envelope (JSON error body)', async () => {
    const http = createUpstreamHttp(
      profile({
        handleResponse: (_response, body) => {
          const envelope = (body ?? {}) as { code?: number; msg?: string };
          throw new ActionError('not_found', `not found: ${envelope.msg}`);
        },
        fetchImpl: fakeFetch(
          () => new Response('{"code":10662,"msg":"no such file"}', { status: 400 }),
        ),
      }),
    );

    await expect(http.download('/open-apis/drive/v1/medias/missing/download')).rejects.toMatchObject({
      code: 'not_found',
      message: 'not found: no such file',
    });
  });

  it('throws a generic upstream_error when the profile declines to map a failed download', async () => {
    const http = createUpstreamHttp(
      profile({
        handleResponse: () => ({}),
        fetchImpl: fakeFetch(() => new Response('teapot', { status: 418 })),
      }),
    );

    await expect(http.download('/x')).rejects.toMatchObject({
      code: 'upstream_error',
      message: 'Example API download failed (HTTP 418)',
    });
  });

  it('rejects an over-cap artifact announced by content-length before reading the body', async () => {
    const http = createUpstreamHttp(
      profile({
        fetchImpl: fakeFetch(
          () =>
            new Response('x'.repeat(11), {
              status: 200,
              headers: { 'content-length': '11' },
            }),
        ),
      }),
    );
    await expect(http.download('/x', { maxBytes: 10 })).rejects.toMatchObject({
      code: 'upstream_error',
      retryable: false,
      message: 'Example API artifact exceeds the download cap: 11 bytes (cap 10)',
    });
  });

  it('rejects an over-cap artifact whose size only the body reveals (lying content-length)', async () => {
    const http = createUpstreamHttp(
      profile({
        fetchImpl: fakeFetch(
          () =>
            new Response('x'.repeat(12), {
              status: 200,
              headers: { 'content-length': '3' },
            }),
        ),
      }),
    );

    await expect(http.download('/x', { maxBytes: 10 })).rejects.toMatchObject({
      code: 'upstream_error',
      message: 'Example API artifact exceeds the download cap: 12 bytes (cap 10)',
    });
  });

  it('maps an HTTP 200 JSON error envelope through the profile (Feishu convention: status lies, code does not)', async () => {
    const http = createUpstreamHttp(
      profile({
        handleResponse: (_response, body) => {
          const envelope = (body ?? {}) as { code?: number };
          if (envelope.code !== 0) {
            throw new ActionError('not_found', `envelope failure ${envelope.code}`);
          }
          return {};
        },
        fetchImpl: fakeFetch(
          () =>
            new Response('{"code":10662,"msg":"document not found"}', {
              status: 200,
              headers: { 'content-type': 'application/json' },
            }),
        ),
      }),
    );

    await expect(http.download('/x')).rejects.toMatchObject({
      code: 'not_found',
      message: 'envelope failure 10662',
    });
  });

  it('returns JSON bytes as the artifact when the envelope reports success', async () => {
    const http = createUpstreamHttp(
      profile({
        handleResponse: () => ({}),
        fetchImpl: fakeFetch(
          () =>
            new Response('{"code":0}', {
              status: 200,
              headers: { 'content-type': 'application/json' },
            }),
        ),
      }),
    );

    const file = await http.download('/x');
    expect(Buffer.from(file.bytes).toString('utf8')).toBe('{"code":0}');
  });

  it('throws upstream_error when the download fetch rejects (network failure)', async () => {
    const http = createUpstreamHttp(
      profile({
        fetchImpl: fakeFetch(() => {
          throw new Error('dns failure');
        }),
      }),
    );

    await expect(http.download('/x')).rejects.toMatchObject({
      code: 'upstream_error',
      message: 'Example API unreachable: dns failure',
    });
  });
});
