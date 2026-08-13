/* eslint-disable @typescript-eslint/require-await -- fake provider profiles: implement async interfaces synchronously */
import { describe, expect, it } from 'vitest';
import { encryptValue } from '../../src/crypto.js';
import { ActionError } from '../../src/errors.js';
import {
  createCachedTokenProvider,
  createUserTokenProvider,
  type AppTokenProfile,
  type UserTokenProfile,
} from '../../src/oauth/token-lifecycle.js';
import {
  InMemoryConnectionStateStore,
  InMemoryTokenStore,
} from '../../src/testing/memory-oauth.js';

const MASTER_KEY = 'test-master-key-0123456789abcdef';
const TENANT = 'tenant-lifecycle';
const CONNECTION = 'conn-lifecycle';
const START = Date.parse('2026-01-01T00:00:00Z');

/**
 * The token lifecycle kernel (ADR-0015): the platform-owned machinery
 * behind the user-token and app-token cells — fail-fast, decryption, the
 * early-refresh window, single-flight, write-back, and best-effort
 * marking. Driven here by a FAKE provider profile: no mock server, no
 * provider types. The per-provider suites (feishu/dingtalk) cover the
 * profile halves; this suite owns the kernel.
 */
describe('token lifecycle kernel', () => {
  interface FakeCreds {
    secret: string;
  }

  /** A fake provider profile with per-test failure injection. */
  function fakeProfile(overrides: Partial<UserTokenProfile<FakeCreds>> = {}): {
    profile: UserTokenProfile<FakeCreds>;
    refreshCount: () => number;
  } {
    let refreshCalls = 0;
    const profile: UserTokenProfile<FakeCreds> = {
      getCreds: async () => ({ secret: 'creds-secret' }),
      refresh: async (creds, refreshToken) => {
        refreshCalls += 1;
        // Echo the creds + refresh token so callers can assert what the
        // kernel handed over.
        return {
          accessToken: `fresh_${creds.secret}_${refreshToken}`,
          refreshToken: `fresh_refresh_${refreshToken}`,
          expiresAt: new Date(START + 2 * 60 * 60 * 1000).toISOString(),
        };
      },
      classifyRefreshError: () => ({
        error: new ActionError('upstream_error', 'refresh failed'),
      }),
      noCredsError: () => new ActionError('auth_expired', 'no credentials'),
      ...overrides,
    };
    return { profile, refreshCount: () => refreshCalls };
  }

  /** Fresh stores per test: the cells' state must never leak between tests. */
  function makeProvider(profile: UserTokenProfile<FakeCreds>) {
    const tokens = new InMemoryTokenStore();
    const state = new InMemoryConnectionStateStore();
    const provider = createUserTokenProvider(profile, {
      tokenStore: tokens,
      connectionState: state,
      masterKey: MASTER_KEY,
      now: () => START,
    });
    return { provider, tokens, state };
  }

  function seedTokens(tokens: InMemoryTokenStore, opts: { accessExpiresAt: Date }): void {
    void tokens.upsert({
      tenantId: TENANT,
      connectionId: CONNECTION,
      accessTokenCiphertext: encryptValue(TENANT, 'stored_access', MASTER_KEY),
      refreshTokenCiphertext: encryptValue(TENANT, 'stored_refresh', MASTER_KEY),
      expiresAt: opts.accessExpiresAt.toISOString(),
    });
  }

  describe('user-token cell', () => {
    it('returns the stored token without refreshing while far from expiry', async () => {
      const { profile, refreshCount } = fakeProfile();
      const { provider, tokens } = makeProvider(profile);
      seedTokens(tokens, { accessExpiresAt: new Date(START + 2 * 60 * 60 * 1000) });

      await expect(provider.getValidAccessToken(CONNECTION)).resolves.toBe('stored_access');
      expect(refreshCount()).toBe(0);
    });

    it('refreshes early (inside the 5-minute window) and persists the new pair encrypted', async () => {
      const { profile } = fakeProfile();
      const { provider, tokens } = makeProvider(profile);
      seedTokens(tokens, { accessExpiresAt: new Date(START + 2 * 60 * 1000) }); // 2 min left

      await expect(provider.getValidAccessToken(CONNECTION)).resolves.toBe(
        'fresh_creds-secret_stored_refresh',
      );

      const stored = tokens.list()[0]!;
      expect(stored.expiresAt).toBe(new Date(START + 2 * 60 * 60 * 1000).toISOString());
      // The refreshed pair is stored encrypted, never in plaintext.
      expect(stored.accessTokenCiphertext.startsWith('v1:')).toBe(true);
      expect(stored.accessTokenCiphertext).not.toContain('fresh_');
    });

    it('is single-flight: concurrent calls share exactly one refresh', async () => {
      const { profile, refreshCount } = fakeProfile();
      const { provider, tokens } = makeProvider(profile);
      seedTokens(tokens, { accessExpiresAt: new Date(START + 60 * 1000) });

      const [a, b, c] = await Promise.all([
        provider.getValidAccessToken(CONNECTION),
        provider.getValidAccessToken(CONNECTION),
        provider.getValidAccessToken(CONNECTION),
      ]);
      expect(refreshCount()).toBe(1);
      expect(new Set([a, b, c]).size).toBe(1);
    });

    it('performs the classifier-requested marking, then fails fast on later calls', async () => {
      const { profile } = fakeProfile({
        refresh: async () => {
          throw new Error('provider says no');
        },
        classifyRefreshError: () => ({
          error: new ActionError('auth_expired', 'provider rejected the refresh token'),
          mark: true,
        }),
      });
      const { provider, tokens, state } = makeProvider(profile);
      seedTokens(tokens, { accessExpiresAt: new Date(START + 60 * 1000) });

      await expect(provider.getValidAccessToken(CONNECTION)).rejects.toMatchObject({
        code: 'auth_expired',
      });
      expect(state.getStatusSync(CONNECTION)).toBe('auth_expired');
      // A second call fails fast without invoking refresh again.
      await expect(provider.getValidAccessToken(CONNECTION)).rejects.toMatchObject({
        code: 'auth_expired',
      });
    });

    it('does not mark when the classifier reports a transient failure', async () => {
      const { profile } = fakeProfile({
        refresh: async () => {
          throw new Error('transient');
        },
        classifyRefreshError: () => ({
          error: new ActionError('rate_limited', 'slow down'),
        }),
      });
      const { provider, tokens, state } = makeProvider(profile);
      seedTokens(tokens, { accessExpiresAt: new Date(START + 60 * 1000) });

      await expect(provider.getValidAccessToken(CONNECTION)).rejects.toMatchObject({
        code: 'rate_limited',
      });
      expect(state.getStatusSync(CONNECTION)).toBeUndefined();
    });

    it('fails with auth_expired when no tokens are stored (flow never ran)', async () => {
      const { profile, refreshCount } = fakeProfile();
      const { provider, state } = makeProvider(profile);

      await expect(provider.getValidAccessToken('conn-never-authorized')).rejects.toMatchObject({
        code: 'auth_expired',
      });
      expect(refreshCount()).toBe(0);
      expect(state.getStatusSync('conn-never-authorized')).toBeUndefined();
    });

    it('uses the profile noCredsError when the tenant has no credentials', async () => {
      const { profile } = fakeProfile({
        getCreds: async () => undefined,
        noCredsError: (tenantId) => new ActionError('auth_expired', `no creds for ${tenantId}`),
      });
      const { provider, tokens } = makeProvider(profile);
      seedTokens(tokens, { accessExpiresAt: new Date(START + 60 * 1000) });

      await expect(provider.getValidAccessToken(CONNECTION)).rejects.toMatchObject({
        code: 'auth_expired',
        message: `no creds for ${TENANT}`,
      });
    });

    it('reports undecryptable stored tokens as upstream_error without marking', async () => {
      const { profile, refreshCount } = fakeProfile();
      const { provider, tokens, state } = makeProvider(profile);
      void tokens.upsert({
        tenantId: TENANT,
        connectionId: CONNECTION,
        accessTokenCiphertext: 'v1:AAAAAAAAAAAAAAAA:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
        refreshTokenCiphertext: 'v1:AAAAAAAAAAAAAAAA:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
        expiresAt: new Date(START + 60 * 1000).toISOString(),
      });

      await expect(provider.getValidAccessToken(CONNECTION)).rejects.toMatchObject({
        code: 'upstream_error',
      });
      expect(state.getStatusSync(CONNECTION)).toBeUndefined();
      expect(refreshCount()).toBe(0);
    });
  });

  describe('app-token (cached) cell', () => {
    function fakeAppProfile(
      overrides: Partial<AppTokenProfile> = {},
    ): { profile: AppTokenProfile; fetchCalls: () => number } {
      let fetchCalls = 0;
      const profile: AppTokenProfile = {
        fetch: async (key) => {
          fetchCalls += 1;
          return {
            // The counter keeps every fetch's token distinct (real upstreams
            // issue fresh tokens), so refetch assertions are meaningful.
            accessToken: `app_${key}_${fetchCalls}`,
            expiresAt: new Date(START + 2 * 60 * 60 * 1000).toISOString(),
          };
        },
        classifyFetchError: () => new ActionError('upstream_error', 'fetch failed'),
        ...overrides,
      };
      return { profile, fetchCalls: () => fetchCalls };
    }

    it('fetches once and serves the cache while far from expiry', async () => {
      const { profile, fetchCalls } = fakeAppProfile();
      const provider = createCachedTokenProvider(profile, { now: () => START });

      const first = await provider.getValid(TENANT);
      const second = await provider.getValid(TENANT);
      expect(second).toBe(first);
      expect(fetchCalls()).toBe(1);
    });

    it('refetches inside the early-refresh window', async () => {
      let now = START;
      const { profile, fetchCalls } = fakeAppProfile();
      const provider = createCachedTokenProvider(profile, { now: () => now });

      const first = await provider.getValid(TENANT);
      now = START + (2 * 60 - 4) * 60 * 1000; // 2h token, 4 min left
      const second = await provider.getValid(TENANT);
      expect(second).not.toBe(first);
      expect(fetchCalls()).toBe(2);
    });

    it('is single-flight for concurrent fetches per key', async () => {
      const { profile, fetchCalls } = fakeAppProfile();
      const provider = createCachedTokenProvider(profile, { now: () => START });

      const [a, b] = await Promise.all([provider.getValid(TENANT), provider.getValid(TENANT)]);
      expect(a).toBe(b);
      expect(fetchCalls()).toBe(1);
    });

    it('maps fetch failures through the classifier', async () => {
      const { profile } = fakeAppProfile({
        fetch: async () => {
          throw new Error('app creds rejected');
        },
        classifyFetchError: () => new ActionError('upstream_error', 'app creds rejected'),
      });
      const provider = createCachedTokenProvider(profile, { now: () => START });

      await expect(provider.getValid(TENANT)).rejects.toMatchObject({ code: 'upstream_error' });
    });
  });
});
