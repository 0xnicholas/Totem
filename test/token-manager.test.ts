import { serve, type ServerType } from '@hono/node-server';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { encryptValue } from '../src/feishu/crypto.js';
import { createFeishuOAuthClient, type FeishuOAuthClient } from '../src/feishu/oauth.js';
import { TokenManager } from '../src/feishu/token-manager.js';
import type { StoredTokens } from '../src/feishu/token-store.js';
import {
  InMemoryConnectionStateStore,
  InMemoryFeishuCredsStore,
  InMemoryTokenStore,
} from '../src/testing/memory-feishu.js';
import { MockFeishuServer } from '../src/testing/mock-feishu-server.js';

const APP_ID = 'tm_app_id';
const APP_SECRET = 'tm_app_secret';
const MASTER_KEY = 'test-master-key-0123456789abcdef';
const TENANT = 'tenant-tm';
const CONNECTION = 'conn-tm';
const REDIRECT_URI = 'https://totem.example.com/oauth/callback/feishu';
const START = Date.parse('2026-01-01T00:00:00Z');

/**
 * The TokenManager (ADR-0004): the deep module hiding the whole OAuth
 * token lifecycle behind `getValidAccessToken` — early refresh inside a
 * 5-minute window, single-flight refreshes per connection, auth_expired
 * marking on revoked refresh tokens. The mock server stands in for Feishu
 * and the clock is injectable, so "time advancing" is a variable, not a
 * wait.
 */
describe('TokenManager', () => {
  let server: ServerType;
  let mock: MockFeishuServer;
  let oauth: FeishuOAuthClient;
  let now: number;
  let tokenStore: InMemoryTokenStore;
  let credsStore: InMemoryFeishuCredsStore;
  let connectionState: InMemoryConnectionStateStore;
  let manager: TokenManager;

  beforeEach(async () => {
    now = START;
    mock = new MockFeishuServer({ appId: APP_ID, appSecret: APP_SECRET });
    server = serve({ fetch: mock.app.fetch, port: 0 });
    await new Promise((resolve) => server.once('listening', resolve));
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    oauth = createFeishuOAuthClient(baseUrl, () => now);
    tokenStore = new InMemoryTokenStore();
    credsStore = new InMemoryFeishuCredsStore();
    credsStore.set(TENANT, { appId: APP_ID, appSecret: APP_SECRET });
    connectionState = new InMemoryConnectionStateStore();
    manager = new TokenManager({
      tokenStore,
      credsStore,
      oauth,
      connectionState,
      masterKey: MASTER_KEY,
      now: () => now,
    });
  });

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it('returns the stored access token without refreshing while far from expiry', async () => {
    const pair = await issueRealPair();
    seedTokens(pair, { accessExpiresAt: new Date(START + 2 * 60 * 60 * 1000) });

    await expect(manager.getValidAccessToken(CONNECTION)).resolves.toBe(pair.accessToken);
    expect(mock.refreshRequestCount).toBe(0);
  });

  it('refreshes early (inside the 5-minute window) and persists the new pair', async () => {
    const pair = await issueRealPair();
    seedTokens(pair, { accessExpiresAt: new Date(START + 2 * 60 * 1000) }); // 2 min left

    const token = await manager.getValidAccessToken(CONNECTION);
    expect(token).not.toBe(pair.accessToken);
    expect(mock.refreshRequestCount).toBe(1);

    const stored = tokenStore.list()[0]!;
    expect(stored.expiresAt).toBe(new Date(START + 2 * 60 * 60 * 1000).toISOString());
    // The new pair is stored encrypted, never in plaintext.
    expect(stored.accessTokenCiphertext).not.toContain(token);
    expect(stored.accessTokenCiphertext.startsWith('v1:')).toBe(true);
  });

  it('is single-flight: concurrent calls share exactly one refresh', async () => {
    const pair = await issueRealPair();
    seedTokens(pair, { accessExpiresAt: new Date(START + 60 * 1000) });

    const [a, b, c] = await Promise.all([
      manager.getValidAccessToken(CONNECTION),
      manager.getValidAccessToken(CONNECTION),
      manager.getValidAccessToken(CONNECTION),
    ]);
    expect(mock.refreshRequestCount).toBe(1);
    expect(new Set([a, b, c]).size).toBe(1);
  });

  it('maps a revoked refresh token to auth_expired and marks the connection', async () => {
    const pair = await issueRealPair();
    seedTokens(pair, { accessExpiresAt: new Date(START + 60 * 1000) });
    mock.revokeRefreshToken(pair.refreshToken);

    await expect(manager.getValidAccessToken(CONNECTION)).rejects.toMatchObject({
      code: 'auth_expired',
      retryable: false,
    });
    expect(connectionState.getStatusSync(CONNECTION)).toBe('auth_expired');
    // A second call fails fast without hitting Feishu again.
    await expect(manager.getValidAccessToken(CONNECTION)).rejects.toMatchObject({
      code: 'auth_expired',
    });
    expect(mock.refreshRequestCount).toBe(1);
  });

  it('maps a Feishu rate limit during refresh to rate_limited', async () => {
    const pair = await issueRealPair();
    seedTokens(pair, { accessExpiresAt: new Date(START + 60 * 1000) });
    mock.failNextRefresh({ code: 99991, msg: 'too many requests', httpStatus: 429 });

    await expect(manager.getValidAccessToken(CONNECTION)).rejects.toMatchObject({
      code: 'rate_limited',
      retryable: true,
    });
    expect(connectionState.getStatusSync(CONNECTION)).toBeUndefined();
  });

  it('fails with auth_expired when no tokens are stored (flow never ran)', async () => {
    await expect(manager.getValidAccessToken('conn-never-authorized')).rejects.toMatchObject({
      code: 'auth_expired',
    });
    expect(mock.refreshRequestCount).toBe(0);
    expect(connectionState.getStatusSync('conn-never-authorized')).toBeUndefined();
  });

  it('fails with auth_expired when the tenant has no Feishu credentials', async () => {
    credsStore.clear();
    const pair = await issueRealPair();
    seedTokens(pair, { accessExpiresAt: new Date(START + 60 * 1000) });

    await expect(manager.getValidAccessToken(CONNECTION)).rejects.toMatchObject({
      code: 'auth_expired',
    });
  });

  it('reports undecryptable stored tokens as upstream_error without marking the connection', async () => {
    const pair = await issueRealPair();
    seedTokens(pair, { accessExpiresAt: new Date(START + 60 * 1000), corrupt: true });

    await expect(manager.getValidAccessToken(CONNECTION)).rejects.toMatchObject({
      code: 'upstream_error',
    });
    expect(connectionState.getStatusSync(CONNECTION)).toBeUndefined();
    expect(mock.refreshRequestCount).toBe(0);
  });

  /** Issues a real token pair from the mock and stores it encrypted. */
  function seedTokens(
    pair: { accessToken: string; refreshToken: string },
    opts: { accessExpiresAt: Date; corrupt?: boolean },
  ): void {
    const stored: StoredTokens = {
      tenantId: TENANT,
      connectionId: CONNECTION,
      accessTokenCiphertext: opts.corrupt
        ? 'v1:AAAAAAAAAAAAAAAA:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'
        : encryptValue(TENANT, pair.accessToken, MASTER_KEY),
      refreshTokenCiphertext: opts.corrupt
        ? 'v1:AAAAAAAAAAAAAAAA:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'
        : encryptValue(TENANT, pair.refreshToken, MASTER_KEY),
      expiresAt: opts.accessExpiresAt.toISOString(),
    };
    void tokenStore.upsert(stored);
  }

  async function issueRealPair(): Promise<{ accessToken: string; refreshToken: string }> {
    const code = await mock.authorizeCode(REDIRECT_URI, 'state-seed');
    return oauth.exchangeCode({
      creds: { appId: APP_ID, appSecret: APP_SECRET },
      code,
      redirectUri: REDIRECT_URI,
    });
  }
});
