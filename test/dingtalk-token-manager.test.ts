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
});
