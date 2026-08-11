import { serve, type ServerType } from '@hono/node-server';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { encryptValue } from '../src/feishu/crypto.js';
import { createDingTalkOAuthClient, type DingTalkOAuthClient } from '../src/dingtalk/oauth.js';
import { DingTalkTokenManager } from '../src/dingtalk/token-manager.js';
import type { StoredTokens } from '../src/feishu/token-store.js';
import { InMemoryDingTalkCredsStore } from '../src/testing/memory-dingtalk.js';
import {
  InMemoryConnectionStateStore,
  InMemoryTokenStore,
} from '../src/testing/memory-feishu.js';
import { MockDingTalkServer } from '../src/testing/mock-dingtalk-server.js';

const APP_KEY = 'tm_app_key';
const APP_SECRET = 'tm_app_secret';
const MASTER_KEY = 'test-master-key-0123456789abcdef';
const TENANT = 'tenant-tm';
const CONNECTION = 'conn-tm';
const START = Date.parse('2026-01-01T00:00:00Z');

/**
 * The DingTalkTokenManager (ADR-0004): the deep module hiding the whole
 * OAuth token lifecycle behind `getValidAccessToken` — early refresh
 * inside a 5-minute window, single-flight refreshes per connection,
 * auth_expired marking on revoked refresh tokens. The mock server stands
 * in for DingTalk and the clock is injectable, so "time advancing" is a
 * variable, not a wait.
 */
describe('DingTalkTokenManager', () => {
  let server: ServerType;
  let mock: MockDingTalkServer;
  let oauth: DingTalkOAuthClient;
  let now: number;
  let tokenStore: InMemoryTokenStore;
  let credsStore: InMemoryDingTalkCredsStore;
  let connectionState: InMemoryConnectionStateStore;
  let manager: DingTalkTokenManager;

  beforeEach(async () => {
    now = START;
    mock = new MockDingTalkServer({ appKey: APP_KEY, appSecret: APP_SECRET });
    server = serve({ fetch: mock.app.fetch, port: 0 });
    await new Promise((resolve) => server.once('listening', resolve));
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    oauth = createDingTalkOAuthClient({ apiBaseUrl: baseUrl, authorizeBaseUrl: baseUrl, now: () => now });
    tokenStore = new InMemoryTokenStore();
    credsStore = new InMemoryDingTalkCredsStore();
    credsStore.set(TENANT, { appKey: APP_KEY, appSecret: APP_SECRET });
    connectionState = new InMemoryConnectionStateStore();
    manager = new DingTalkTokenManager({
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

  async function issueRealPair(): Promise<{ accessToken: string; refreshToken: string }> {
    const code = await mock.authorizeCode('https://totem.example.com/oauth/callback/dingtalk', 's');
    return oauth.exchangeCode({ creds: { appKey: APP_KEY, appSecret: APP_SECRET }, code });
  }

  function seedTokens(
    pair: { accessToken: string; refreshToken: string },
    opts: { accessExpiresAt: Date },
  ): void {
    void tokenStore.upsert({
      tenantId: TENANT,
      connectionId: CONNECTION,
      accessTokenCiphertext: encryptValue(TENANT, pair.accessToken, MASTER_KEY),
      refreshTokenCiphertext: encryptValue(TENANT, pair.refreshToken, MASTER_KEY),
      expiresAt: opts.accessExpiresAt.toISOString(),
    } satisfies StoredTokens);
  }

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
    // A second call fails fast without hitting DingTalk again.
    await expect(manager.getValidAccessToken(CONNECTION)).rejects.toMatchObject({
      code: 'auth_expired',
    });
    expect(mock.refreshRequestCount).toBe(1);
  });

  it('maps a DingTalk rate limit during refresh to rate_limited', async () => {
    const pair = await issueRealPair();
    seedTokens(pair, { accessExpiresAt: new Date(START + 60 * 1000) });
    mock.failNext({ code: 'TooManyRequests', message: 'slow down', httpStatus: 429 });

    await expect(manager.getValidAccessToken(CONNECTION)).rejects.toMatchObject({
      code: 'rate_limited',
      retryable: true,
    });
    expect(connectionState.getStatusSync(CONNECTION)).toBeUndefined();
  });

  it('maps a 5xx refresh failure to upstream_error without poisoning the connection', async () => {
    const pair = await issueRealPair();
    seedTokens(pair, { accessExpiresAt: new Date(START + 60 * 1000) });
    mock.failNext({ code: 'InternalError', message: 'boom', httpStatus: 500 });

    await expect(manager.getValidAccessToken(CONNECTION)).rejects.toMatchObject({
      code: 'upstream_error',
      retryable: false,
    });
    // A transient server failure is not a dead grant: no auth_expired marking.
    expect(connectionState.getStatusSync(CONNECTION)).toBeUndefined();
  });

  it('fails with auth_expired when no tokens are stored (flow never ran)', async () => {
    await expect(manager.getValidAccessToken('conn-never-authorized')).rejects.toMatchObject({
      code: 'auth_expired',
    });
    expect(mock.refreshRequestCount).toBe(0);
    expect(connectionState.getStatusSync('conn-never-authorized')).toBeUndefined();
  });

  it('fails with auth_expired when the tenant has no DingTalk credentials', async () => {
    credsStore.clear();
    const pair = await issueRealPair();
    seedTokens(pair, { accessExpiresAt: new Date(START + 60 * 1000) });
    await expect(manager.getValidAccessToken(CONNECTION)).rejects.toMatchObject({
      code: 'auth_expired',
    });
  });

  it('fails fast when the connection is already marked auth_expired', async () => {
    void connectionState.markAuthExpired(CONNECTION);
    await expect(manager.getValidAccessToken(CONNECTION)).rejects.toMatchObject({
      code: 'auth_expired',
    });
    expect(mock.refreshRequestCount).toBe(0);
  });

  it('fetches the app token once and serves it from cache (T17 live pass)', async () => {
    const first = await manager.getValidAppAccessToken(TENANT);
    expect(first).toMatch(/^dt_app_/);
    const second = await manager.getValidAppAccessToken(TENANT);
    expect(second).toBe(first);
    expect(mock.appTokenRequestCount).toBe(1);
  });

  it('refetches the app token inside the early-refresh window', async () => {
    const first = await manager.getValidAppAccessToken(TENANT);
    // Mock app tokens live 2h; advance the clock past the 5-minute window.
    now = START + (2 * 60 - 4) * 60 * 1000;
    const second = await manager.getValidAppAccessToken(TENANT);
    expect(second).not.toBe(first);
    expect(mock.appTokenRequestCount).toBe(2);
  });

  it('is single-flight for concurrent app-token fetches', async () => {
    const fresh = 'tenant-app-singleflight';
    credsStore.set(fresh, { appKey: APP_KEY, appSecret: APP_SECRET });
    const before = mock.appTokenRequestCount;
    const [a, b] = await Promise.all([
      manager.getValidAppAccessToken(fresh),
      manager.getValidAppAccessToken(fresh),
    ]);
    expect(a).toBe(b);
    expect(mock.appTokenRequestCount - before).toBe(1);
  });

  it('maps invalid app credentials to upstream_error WITHOUT poisoning the connection', async () => {
    const badTenant = 'tenant-app-badcreds';
    credsStore.set(badTenant, { appKey: 'bad', appSecret: 'bad' });
    await expect(manager.getValidAppAccessToken(badTenant)).rejects.toMatchObject({
      code: 'upstream_error',
      upstream: { code: 'InvalidClient' },
    });
    // The user grant is unrelated to the app credentials: the connection
    // must stay usable for identity flows (never marked auth_expired).
    expect(await connectionState.getStatus(CONNECTION)).not.toBe('auth_expired');
  });

  it('fails with upstream_error when the tenant has no credentials', async () => {
    credsStore.clear();
    await expect(manager.getValidAppAccessToken('tenant-app-nocreds')).rejects.toMatchObject({
      code: 'upstream_error',
    });
  });

  it('maps a rate limit during app-token fetch to rate_limited', async () => {
    credsStore.set('tenant-app-ratelimited', { appKey: APP_KEY, appSecret: APP_SECRET });
    mock.failNext({ code: 'TooManyRequests', message: 'slow down', httpStatus: 429 });
    await expect(manager.getValidAppAccessToken('tenant-app-ratelimited')).rejects.toMatchObject({
      code: 'rate_limited',
      retryable: true,
    });
  });
});
