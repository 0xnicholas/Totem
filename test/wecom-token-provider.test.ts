import { serve, type ServerType } from '@hono/node-server';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createWeComOAuthClient } from '../src/wecom/oauth.js';
import { createWeComTokenProvider } from '../src/wecom/tokens.js';
import { ConnectionStore } from '../src/executor.js';
import { InMemoryWeComCredsStore } from '../src/testing/memory-wecom.js';
import { MockWeComServer } from '../src/testing/mock-wecom-server.js';

const CORP_ID = 'tp_corp_id';
const SECRET = 'tp_secret';
const AGENT_ID = '1000002';
const TENANT = 'tenant-wc';
const CONNECTION = 'conn-wc';
const START = Date.parse('2026-01-01T00:00:00Z');
const CREDS = { corpId: CORP_ID, secret: SECRET, agentId: AGENT_ID };

/**
 * The WeCom token adapter (ADR-0017): ONE cell — the cached app-token cell
 * keyed by tenant (`createCachedTokenProvider`: fetch on miss/expiry,
 * single-flight, never marks auth-expired). There is no user-token cell:
 * WeCom has no user OAuth. The provider additionally owns the
 * connection→tenant resolution (the executor's seam is connectionId; the
 * cell and the creds store are per tenant).
 *
 * The cached-cell machinery itself is owned by
 * test/oauth/token-lifecycle.test.ts; this suite covers what only the
 * WeCom adapter decides.
 */
describe('WeCom token provider (cached cell, ADR-0017)', () => {
  let server: ServerType;
  let mock: MockWeComServer;
  let now: number;
  let credsStore: InMemoryWeComCredsStore;
  let connections: ConnectionStore;
  let provider: ReturnType<typeof createWeComTokenProvider>;

  beforeAll(async () => {
    mock = new MockWeComServer({ corpId: CORP_ID, secret: SECRET });
    server = serve({ fetch: mock.app.fetch, port: 0 });
    await new Promise((resolve) => server.once('listening', resolve));
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    credsStore = new InMemoryWeComCredsStore();
    credsStore.set(TENANT, CREDS);
    connections = new ConnectionStore([
      { tenantId: TENANT, connectionId: CONNECTION, connectorId: 'wecom_messaging' },
    ]);
    provider = makeProvider(baseUrl);
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  /** A fresh provider with its own cell (cache isolation per test). */
  function makeProvider(baseUrl: string) {
    return createWeComTokenProvider({
      connections,
      credsStore,
      oauth: createWeComOAuthClient({ apiBaseUrl: baseUrl, now: () => now }),
      now: () => now,
    });
  }

  beforeEach(() => {
    now = START;
  });

  it('acquires the app token on first call and caches it per tenant', async () => {
    const cell = makeProvider(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    const first = await cell.getValidAccessToken(CONNECTION);
    expect(first).toMatch(/^wc_access_/);
    expect(mock.gettokenRequestCount).toBe(1);

    // Cached: a second acquisition within the TTL makes no gettoken call.
    now += 60 * 1000;
    const second = await cell.getValidAccessToken(CONNECTION);
    expect(second).toBe(first);
    expect(mock.gettokenRequestCount).toBe(1);
  });

  it('re-fetches when the cached token enters the early-refresh window', async () => {
    const cell = makeProvider(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    await cell.getValidAccessToken(CONNECTION);
    const before = mock.gettokenRequestCount;
    // 7200s TTL; beyond expiry the cell must fetch again.
    now += 7200 * 1000 + 1000;
    await cell.getValidAccessToken(CONNECTION);
    expect(mock.gettokenRequestCount).toBe(before + 1);
  });

  it('single-flights concurrent acquisitions (one gettoken per cold cell)', async () => {
    const cell = makeProvider(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    const before = mock.gettokenRequestCount;
    const [a, b] = await Promise.all([
      cell.getValidAccessToken(CONNECTION),
      cell.getValidAccessToken(CONNECTION),
    ]);
    expect(a).toBe(b);
    expect(mock.gettokenRequestCount).toBe(before + 1);
  });

  it('fails upstream_error (never auth_expired) when the tenant has no WeCom credentials', async () => {
    credsStore.clear();
    try {
      await expect(provider.getValidAccessToken(CONNECTION)).rejects.toMatchObject({
        code: 'upstream_error',
        retryable: false,
        message: expect.stringMatching(/no WeCom credentials/) as RegExp,
      });
    } finally {
      credsStore.set(TENANT, CREDS);
    }
  });

  it('rejects a rejected gettoken as an operator-credential upstream_error — the connection is never marked auth_expired (ADR-0017)', async () => {
    // 40001 = invalid corpid/secret: the classic dead-credential shape that
    // on user-grant systems means auth_expired. Here it is an operator
    // problem: the vocabulary keeps upstream_error, code preserved.
    credsStore.set(TENANT, { ...CREDS, secret: 'wrong' });
    try {
      const err = await provider.getValidAccessToken(CONNECTION).catch((e: unknown) => e);
      expect(err).toMatchObject({
        code: 'upstream_error',
        retryable: false,
        upstream: { code: '40001' },
      });
    } finally {
      credsStore.set(TENANT, CREDS);
    }
  });

  it('maps an HTTP 429 gettoken to rate_limited (retryable)', async () => {
    mock.failNext({ message: 'too many requests', httpStatus: 429 });
    await expect(provider.getValidAccessToken(CONNECTION)).rejects.toMatchObject({
      code: 'rate_limited',
      retryable: true,
    });
  });

  it('fails upstream_error for an unknown connection id', async () => {
    await expect(provider.getValidAccessToken('conn-none')).rejects.toMatchObject({
      code: 'upstream_error',
      message: expect.stringContaining('conn-none') as RegExp,
    });
  });
});
