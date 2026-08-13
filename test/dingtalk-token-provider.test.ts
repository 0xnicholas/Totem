import { serve, type ServerType } from '@hono/node-server';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { encryptValue } from '../src/crypto.js';
import { createDingTalkOAuthClient, type DingTalkOAuthClient } from '../src/dingtalk/oauth.js';
import { createDingTalkTokenProvider, type DingTalkTokenProvider } from '../src/dingtalk/tokens.js';
import type { StoredTokens } from '../src/oauth/token-store.js';
import { InMemoryDingTalkCredsStore } from '../src/testing/memory-dingtalk.js';
import {
  InMemoryConnectionStateStore,
  InMemoryTokenStore,
} from '../src/testing/memory-oauth.js';
import { MockDingTalkServer } from '../src/testing/mock-dingtalk-server.js';

const APP_KEY = 'tm_app_key';
const APP_SECRET = 'tm_app_secret';
const MASTER_KEY = 'test-master-key-0123456789abcdef';
const TENANT = 'tenant-tm';
const CONNECTION = 'conn-tm';
const START = Date.parse('2026-01-01T00:00:00Z');

/**
 * The DingTalk token adapter (ADR-0015): two cells over the DingTalk
 * profile — the user-token cell (Feishu-shaped classification, DingTalk
 * error families) and the app-token cell (client credentials, cache-only,
 * never marks the connection). The kernel machinery is owned by
 * test/oauth/token-lifecycle.test.ts; this suite covers what only
 * DingTalk can decide.
 */
describe('DingTalk token provider (adapter)', () => {
  let server: ServerType;
  let mock: MockDingTalkServer;
  let oauth: DingTalkOAuthClient;
  let now: number;
  let tokenStore: InMemoryTokenStore;
  let credsStore: InMemoryDingTalkCredsStore;
  let connectionState: InMemoryConnectionStateStore;
  let provider: DingTalkTokenProvider;

  beforeEach(async () => {
    now = START;
    mock = new MockDingTalkServer({ appKey: APP_KEY, appSecret: APP_SECRET });
    server = serve({ fetch: mock.app.fetch, port: 0 });
    await new Promise((resolve) => server.once('listening', resolve));
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    oauth = createDingTalkOAuthClient({
      apiBaseUrl: baseUrl,
      authorizeBaseUrl: baseUrl,
      now: () => now,
    });
    tokenStore = new InMemoryTokenStore();
    credsStore = new InMemoryDingTalkCredsStore();
    credsStore.set(TENANT, { appKey: APP_KEY, appSecret: APP_SECRET });
    connectionState = new InMemoryConnectionStateStore();
    provider = createDingTalkTokenProvider({
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

  /** Issues a real user-token pair from the mock and stores it encrypted. */
  async function seedExpiringTokens(): Promise<void> {
    const code = await mock.authorizeCode('https://totem.example.com/oauth/callback/dingtalk', 's');
    const pair = await oauth.exchangeCode({
      creds: { appKey: APP_KEY, appSecret: APP_SECRET },
      code,
    });
    const stored: StoredTokens = {
      tenantId: TENANT,
      connectionId: CONNECTION,
      accessTokenCiphertext: encryptValue(TENANT, pair.accessToken, MASTER_KEY),
      refreshTokenCiphertext: encryptValue(TENANT, pair.refreshToken, MASTER_KEY),
      expiresAt: new Date(START + 60 * 1000).toISOString(),
    };
    void tokenStore.upsert(stored);
  }

  describe('user-token cell', () => {
    it('maps a DingTalk rate limit during refresh to rate_limited without marking', async () => {
      await seedExpiringTokens();
      mock.failNext({ code: 'TooManyRequests', message: 'slow down', httpStatus: 429 });

      await expect(provider.getValidAccessToken(CONNECTION)).rejects.toMatchObject({
        code: 'rate_limited',
        retryable: true,
      });
      expect(connectionState.getStatusSync(CONNECTION)).toBeUndefined();
    });

    it('maps a 5xx refresh failure to upstream_error without poisoning the connection', async () => {
      await seedExpiringTokens();
      mock.failNext({ code: 'InternalError', message: 'boom', httpStatus: 500 });

      await expect(provider.getValidAccessToken(CONNECTION)).rejects.toMatchObject({
        code: 'upstream_error',
        retryable: false,
      });
      // A transient server failure is not a dead grant: no auth_expired marking.
      expect(connectionState.getStatusSync(CONNECTION)).toBeUndefined();
    });

    it('fails with auth_expired and the DingTalk message when the tenant has no credentials', async () => {
      credsStore.clear();
      await seedExpiringTokens();

      await expect(provider.getValidAccessToken(CONNECTION)).rejects.toMatchObject({
        code: 'auth_expired',
        message: `Tenant "${TENANT}" has no DingTalk credentials configured; refresh impossible`,
      });
    });
  });

  describe('app-token cell', () => {
    it('fetches the app token once and serves it from cache (T17 live pass)', async () => {
      const first = await provider.getValidAppAccessToken(TENANT);
      expect(first).toMatch(/^dt_app_/);
      const second = await provider.getValidAppAccessToken(TENANT);
      expect(second).toBe(first);
      expect(mock.appTokenRequestCount).toBe(1);
    });

    it('refetches the app token inside the early-refresh window', async () => {
      const first = await provider.getValidAppAccessToken(TENANT);
      // Mock app tokens live 2h; advance the clock past the 5-minute window.
      now = START + (2 * 60 - 4) * 60 * 1000;
      const second = await provider.getValidAppAccessToken(TENANT);
      expect(second).not.toBe(first);
      expect(mock.appTokenRequestCount).toBe(2);
    });

    it('is single-flight for concurrent app-token fetches', async () => {
      const fresh = 'tenant-app-singleflight';
      credsStore.set(fresh, { appKey: APP_KEY, appSecret: APP_SECRET });
      const before = mock.appTokenRequestCount;
      const [a, b] = await Promise.all([
        provider.getValidAppAccessToken(fresh),
        provider.getValidAppAccessToken(fresh),
      ]);
      expect(a).toBe(b);
      expect(mock.appTokenRequestCount - before).toBe(1);
    });

    it('maps invalid app credentials to upstream_error WITHOUT poisoning the connection', async () => {
      const badTenant = 'tenant-app-badcreds';
      credsStore.set(badTenant, { appKey: 'bad', appSecret: 'bad' });
      await expect(provider.getValidAppAccessToken(badTenant)).rejects.toMatchObject({
        code: 'upstream_error',
        upstream: { code: 'InvalidClient' },
      });
      // The user grant is unrelated to the app credentials: the connection
      // must stay usable for identity flows (never marked auth_expired).
      expect(await connectionState.getStatus(CONNECTION)).not.toBe('auth_expired');
    });

    it('fails with upstream_error when the tenant has no credentials', async () => {
      credsStore.clear();
      await expect(provider.getValidAppAccessToken('tenant-app-nocreds')).rejects.toMatchObject({
        code: 'upstream_error',
      });
    });

    it('maps a rate limit during app-token fetch to rate_limited', async () => {
      credsStore.set('tenant-app-ratelimited', { appKey: APP_KEY, appSecret: APP_SECRET });
      mock.failNext({ code: 'TooManyRequests', message: 'slow down', httpStatus: 429 });
      await expect(provider.getValidAppAccessToken('tenant-app-ratelimited')).rejects.toMatchObject({
        code: 'rate_limited',
        retryable: true,
      });
    });
  });
});
