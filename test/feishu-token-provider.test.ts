import { serve, type ServerType } from '@hono/node-server';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { encryptValue } from '../src/crypto.js';
import { createFeishuOAuthClient, type FeishuOAuthClient } from '../src/feishu/oauth.js';
import { createFeishuTokenProvider } from '../src/feishu/tokens.js';
import type { TokenProvider } from '../src/oauth/token-lifecycle.js';
import type { StoredTokens } from '../src/oauth/token-store.js';
import {
  InMemoryConnectionStateStore,
  InMemoryTokenStore,
} from '../src/testing/memory-oauth.js';
import { InMemoryFeishuCredsStore } from '../src/testing/memory-feishu.js';
import { MockFeishuServer } from '../src/testing/mock-feishu-server.js';

const APP_ID = 'tm_app_id';
const APP_SECRET = 'tm_app_secret';
const MASTER_KEY = 'test-master-key-0123456789abcdef';
const TENANT = 'tenant-tm';
const CONNECTION = 'conn-tm';
const REDIRECT_URI = 'https://totem.example.com/oauth/callback/feishu';
const START = Date.parse('2026-01-01T00:00:00Z');

/**
 * The Feishu token adapter (ADR-0015): the provider-specific half of the
 * lifecycle — credentials, the refresh call, and failure classification —
 * wired over the real Feishu OAuth client against the mock server. The
 * kernel machinery (early refresh, single-flight, fail-fast, write-back)
 * is owned by test/oauth/token-lifecycle.test.ts; this suite covers what
 * only Feishu can decide: its error-code families and messages.
 */
describe('Feishu token provider (adapter)', () => {
  let server: ServerType;
  let mock: MockFeishuServer;
  let oauth: FeishuOAuthClient;
  let now: number;
  let tokenStore: InMemoryTokenStore;
  let credsStore: InMemoryFeishuCredsStore;
  let connectionState: InMemoryConnectionStateStore;
  let provider: TokenProvider;

  beforeEach(async () => {
    now = START;
    mock = new MockFeishuServer({ appId: APP_ID, appSecret: APP_SECRET });
    server = serve({ fetch: mock.app.fetch, port: 0 });
    await new Promise((resolve) => server.once('listening', resolve));
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    oauth = createFeishuOAuthClient(baseUrl, { now: () => now });
    tokenStore = new InMemoryTokenStore();
    credsStore = new InMemoryFeishuCredsStore();
    credsStore.set(TENANT, { appId: APP_ID, appSecret: APP_SECRET });
    connectionState = new InMemoryConnectionStateStore();
    provider = createFeishuTokenProvider({
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

  /** Issues a real token pair from the mock and stores it encrypted. */
  async function seedExpiringTokens(): Promise<{ refreshToken: string }> {
    const code = await mock.authorizeCode(REDIRECT_URI, 'state-seed');
    const pair = await oauth.exchangeCode({
      creds: { appId: APP_ID, appSecret: APP_SECRET },
      code,
      redirectUri: REDIRECT_URI,
    });
    const stored: StoredTokens = {
      tenantId: TENANT,
      connectionId: CONNECTION,
      accessTokenCiphertext: encryptValue(TENANT, pair.accessToken, MASTER_KEY),
      refreshTokenCiphertext: encryptValue(TENANT, pair.refreshToken, MASTER_KEY),
      expiresAt: new Date(START + 60 * 1000).toISOString(),
    };
    void tokenStore.upsert(stored);
    return { refreshToken: pair.refreshToken };
  }

  it('serves far-from-expiry tokens and refreshes inside the window (end-to-end wiring)', async () => {
    const code = await mock.authorizeCode(REDIRECT_URI, 'state-seed');
    const pair = await oauth.exchangeCode({
      creds: { appId: APP_ID, appSecret: APP_SECRET },
      code,
      redirectUri: REDIRECT_URI,
    });
    void tokenStore.upsert({
      tenantId: TENANT,
      connectionId: CONNECTION,
      accessTokenCiphertext: encryptValue(TENANT, pair.accessToken, MASTER_KEY),
      refreshTokenCiphertext: encryptValue(TENANT, pair.refreshToken, MASTER_KEY),
      expiresAt: new Date(START + 2 * 60 * 60 * 1000).toISOString(),
    });

    await expect(provider.getValidAccessToken(CONNECTION)).resolves.toBe(pair.accessToken);
    expect(mock.refreshRequestCount).toBe(0);

    // Re-seed with 1 minute left: the adapter's refresh path runs.
    void tokenStore.upsert({
      tenantId: TENANT,
      connectionId: CONNECTION,
      accessTokenCiphertext: encryptValue(TENANT, pair.accessToken, MASTER_KEY),
      refreshTokenCiphertext: encryptValue(TENANT, pair.refreshToken, MASTER_KEY),
      expiresAt: new Date(START + 60 * 1000).toISOString(),
    });
    await expect(provider.getValidAccessToken(CONNECTION)).resolves.not.toBe(pair.accessToken);
    expect(mock.refreshRequestCount).toBe(1);
  });

  it('maps a revoked refresh token to auth_expired and marks the connection', async () => {
    const { refreshToken } = await seedExpiringTokens();
    mock.revokeRefreshToken(refreshToken);

    await expect(provider.getValidAccessToken(CONNECTION)).rejects.toMatchObject({
      code: 'auth_expired',
      retryable: false,
    });
    expect(connectionState.getStatusSync(CONNECTION)).toBe('auth_expired');
    // A second call fails fast without hitting Feishu again.
    await expect(provider.getValidAccessToken(CONNECTION)).rejects.toMatchObject({
      code: 'auth_expired',
    });
    expect(mock.refreshRequestCount).toBe(1);
  });

  it('maps a Feishu rate limit during refresh to rate_limited without marking', async () => {
    await seedExpiringTokens();
    mock.failNextRefresh({ code: 99991, msg: 'too many requests', httpStatus: 429 });

    await expect(provider.getValidAccessToken(CONNECTION)).rejects.toMatchObject({
      code: 'rate_limited',
      retryable: true,
    });
    expect(connectionState.getStatusSync(CONNECTION)).toBeUndefined();
  });

  it('fails with auth_expired and the Feishu message when the tenant has no credentials', async () => {
    credsStore.clear();
    await seedExpiringTokens();

    await expect(provider.getValidAccessToken(CONNECTION)).rejects.toMatchObject({
      code: 'auth_expired',
      message: `Tenant "${TENANT}" has no Feishu credentials configured; refresh impossible`,
    });
  });
});
