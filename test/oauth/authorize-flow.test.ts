/* eslint-disable @typescript-eslint/require-await -- fake provider profile: implements an async interface synchronously */
import { describe, expect, it } from 'vitest';
import { decryptValue } from '../../src/crypto.js';
import {
  createOAuthFlow,
  FlowError,
  type AuthorizeProfile,
  type OAuthFlow,
} from '../../src/oauth/authorize-flow.js';
import { InMemoryAdminRepository } from '../../src/testing/memory-admin-repo.js';
import { InMemoryTokenStore } from '../../src/testing/memory-oauth.js';

const MASTER_KEY = 'test-master-key-0123456789abcdef';
const CONNECTOR_ID = 'fake_docs';
const CONNECTION_NAME = 'fake';
const REDIRECT_URI = 'https://totem.example.com/oauth/callback/fake';
const START = Date.parse('2026-01-01T00:00:00Z');

interface FakeCreds {
  key: string;
  secret: string;
}

/**
 * The Authorize Flow state machine (ADR-0015): pending-state recording and
 * TTL, creds checks, caller-vs-internal error classification, and the
 * connection-first-then-tokens ordering. Driven by a FAKE provider
 * profile; the per-provider suites cover the URL shapes and exchange
 * specifics of the real adapters.
 */
describe('authorize flow machine', () => {
  function makeHarness(overrides: Partial<AuthorizeProfile<FakeCreds>> = {}) {
    let now = START;
    let failureCaller = false;
    let nextFailure: Error | undefined;
    const creds = new Map<string, FakeCreds>();
    const built = new Array<{ creds: FakeCreds; redirectUri: string; state: string }>();

    const profile: AuthorizeProfile<FakeCreds> = {
      providerName: 'Fake',
      getCreds: async (tenantId) => creds.get(tenantId),
      noCredsMessage: (tenantId) =>
        `Tenant "${tenantId}" has no Fake credentials configured (set-fake-creds)`,
      buildAuthorizationUrl: (c, redirectUri, state) => {
        built.push({ creds: c, redirectUri, state });
        return `https://fake.example.com/authorize?client_id=${c.key}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`;
      },
      exchangeCode: async (c, code) => {
        if (nextFailure !== undefined) {
          const failure = nextFailure;
          nextFailure = undefined;
          throw failure;
        }
        return {
          accessToken: `access_${c.secret}_${code}`,
          refreshToken: `refresh_${code}`,
          expiresAt: new Date(START + 2 * 60 * 60 * 1000).toISOString(),
        };
      },
      isCallerError: () => failureCaller,
      ...overrides,
    };

    const tokenStore = new InMemoryTokenStore();
    const repo = new InMemoryAdminRepository();
    const flow = createOAuthFlow(profile, {
      tokenStore,
      connections: repo,
      masterKey: MASTER_KEY,
      connectorId: CONNECTOR_ID,
      connectionName: CONNECTION_NAME,
      now: () => now,
    });

    return {
      flow,
      tokenStore,
      repo,
      built,
      creds,
      advance: (ms: number) => {
        now += ms;
      },
      /** Queues a failure for the next exchange (caller-fixable or internal). */
      failNextExchange: (err: Error, caller: boolean) => {
        nextFailure = err;
        failureCaller = caller;
      },
    };
  }

  async function withTenant(
    h: ReturnType<typeof makeHarness>,
    name: string,
    withCreds = true,
  ): Promise<string> {
    const tenant = (await h.repo.createTenant(`tenant-${name}`)).id;
    if (withCreds) h.creds.set(tenant, { key: `key_${name}`, secret: `secret_${name}` });
    return tenant;
  }

  async function startAndState(flow: OAuthFlow, tenant: string): Promise<string> {
    const { authorizationUrl } = await flow.start(tenant, REDIRECT_URI);
    return new URL(authorizationUrl).searchParams.get('state')!;
  }

  it('start builds the authorization URL through the profile and records state', async () => {
    const h = makeHarness();
    const tenant = await withTenant(h, 'start');

    const { authorizationUrl } = await h.flow.start(tenant, REDIRECT_URI);
    const url = new URL(authorizationUrl);
    expect(url.searchParams.get('client_id')).toBe('key_start');
    expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT_URI);
    expect(url.searchParams.get('state')).toBeTruthy();
    // The profile received the creds and the caller's redirect.
    expect(h.built[0]).toMatchObject({ creds: { key: 'key_start' }, redirectUri: REDIRECT_URI });
  });

  it('start fails with 400 and the profile message when the tenant has no credentials', async () => {
    const h = makeHarness();
    const tenant = await withTenant(h, 'nocreds', false);

    await expect(h.flow.start(tenant, REDIRECT_URI)).rejects.toBeInstanceOf(FlowError);
    await expect(h.flow.start(tenant, REDIRECT_URI)).rejects.toMatchObject({
      status: 400,
      message: `Tenant "${tenant}" has no Fake credentials configured (set-fake-creds)`,
    });
  });

  it('callback exchanges the code, creates the connection and stores encrypted tokens', async () => {
    const h = makeHarness();
    const tenant = await withTenant(h, 'callback');

    const state = await startAndState(h.flow, tenant);
    await h.flow.handleCallback('the-code', state);

    const created = h.repo
      .listConnectionsSync(tenant)
      .find((c) => c.name === CONNECTION_NAME)!;
    expect(created).toMatchObject({
      tenantId: tenant,
      connectorId: CONNECTOR_ID,
      status: 'active',
      oauthRedirectUri: REDIRECT_URI,
    });

    const stored = h.tokenStore.list()[0]!;
    expect(stored.connectionId).toBe(created.id);
    expect(stored.accessTokenCiphertext.startsWith('v1:')).toBe(true);
    expect(decryptValue(tenant, stored.accessTokenCiphertext, MASTER_KEY)).toBe(
      'access_secret_callback_the-code',
    );
    expect(decryptValue(tenant, stored.refreshTokenCiphertext, MASTER_KEY)).toBe(
      'refresh_the-code',
    );
  });

  it('rejects an unknown or consumed state with 400 and creates nothing', async () => {
    const h = makeHarness();
    const tenant = await withTenant(h, 'state');

    await expect(h.flow.handleCallback('code', 'never-issued')).rejects.toMatchObject({
      name: 'FlowError',
      status: 400,
    });

    const state = await startAndState(h.flow, tenant);
    await h.flow.handleCallback('code', state);
    // Replay of the same state (e.g. a retried browser redirect) fails.
    await expect(h.flow.handleCallback('code', state)).rejects.toMatchObject({ status: 400 });
    expect(h.tokenStore.list()).toHaveLength(1);
  });

  it('rejects expired states with 400 (state TTL)', async () => {
    const h = makeHarness();
    const tenant = await withTenant(h, 'ttl');

    const state = await startAndState(h.flow, tenant);
    h.advance(11 * 60 * 1000); // 11 minutes later; default TTL is 10

    await expect(h.flow.handleCallback('code', state)).rejects.toMatchObject({
      name: 'FlowError',
      status: 400,
    });
    expect(h.tokenStore.list()).toHaveLength(0);
  });

  it('maps a caller-fixable exchange failure to 400', async () => {
    const h = makeHarness();
    const tenant = await withTenant(h, 'caller');
    h.failNextExchange(new Error('bad code'), true);

    const state = await startAndState(h.flow, tenant);
    await expect(h.flow.handleCallback('bad-code', state)).rejects.toMatchObject({
      status: 400,
      message: 'Fake authorization failed: bad code',
    });
    expect(h.tokenStore.list()).toHaveLength(0);
  });

  it('maps an internal exchange failure to 500', async () => {
    const h = makeHarness();
    const tenant = await withTenant(h, 'internal');
    h.failNextExchange(new Error('network down'), false);

    const state = await startAndState(h.flow, tenant);
    await expect(h.flow.handleCallback('code', state)).rejects.toMatchObject({
      status: 500,
    });
    expect(h.tokenStore.list()).toHaveLength(0);
  });

  it('a second flow creates a second connection (multi-connection)', async () => {
    const h = makeHarness();
    const tenant = await withTenant(h, 'multi');

    await h.flow.handleCallback('c1', await startAndState(h.flow, tenant));
    await h.flow.handleCallback('c2', await startAndState(h.flow, tenant));

    const created = h.repo.listConnectionsSync(tenant).filter((c) => c.name === CONNECTION_NAME);
    expect(created).toHaveLength(2);
    expect(new Set(created.map((c) => c.id)).size).toBe(2);
  });

  it('re-authorizes an existing connection in place (reactivates, replaces tokens)', async () => {
    const h = makeHarness();
    const tenant = await withTenant(h, 'reauth');
    h.repo.addConnection(tenant, 'existing-conn');

    const { authorizationUrl } = await h.flow.start(tenant, REDIRECT_URI, {
      connectionId: 'existing-conn',
    });
    const state = new URL(authorizationUrl).searchParams.get('state')!;
    await h.flow.handleCallback('code', state);

    // No new connection: the existing row was reactivated, tokens replaced.
    expect(h.repo.listConnectionsSync(tenant)).toHaveLength(1);
    const stored = h.tokenStore.list()[0]!;
    expect(stored.connectionId).toBe('existing-conn');
    expect(decryptValue(tenant, stored.refreshTokenCiphertext, MASTER_KEY)).toBe('refresh_code');
  });

  it('lets a token-store failure propagate as a raw error (admin surfaces 500)', async () => {
    const h = makeHarness();
    const tenant = await withTenant(h, 'storefail');
    h.tokenStore.upsert = async () => {
      throw new Error('store down');
    };

    const state = await startAndState(h.flow, tenant);
    await expect(h.flow.handleCallback('code', state)).rejects.toMatchObject({
      message: 'store down',
    });
  });
});
