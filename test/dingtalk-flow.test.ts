import { serve, type ServerType } from '@hono/node-server';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decryptValue } from '../src/crypto.js';
import { createDingTalkOAuthClient, type DingTalkOAuthClient } from '../src/dingtalk/oauth.js';
import { createDingTalkOAuthFlow } from '../src/dingtalk/flows.js';
import { FlowError, type OAuthFlow } from '../src/oauth/authorize-flow.js';
import { InMemoryAdminRepository } from '../src/testing/memory-admin-repo.js';
import { InMemoryDingTalkCredsStore } from '../src/testing/memory-dingtalk.js';
import { InMemoryTokenStore } from '../src/testing/memory-oauth.js';
import { MockDingTalkServer } from '../src/testing/mock-dingtalk-server.js';

const APP_KEY = 'flow_app_key';
const APP_SECRET = 'flow_app_secret';
const MASTER_KEY = 'test-master-key-0123456789abcdef';
let TENANT: string;
const REDIRECT_URI = 'https://totem.example.com/oauth/callback/dingtalk';
const START = Date.parse('2026-01-01T00:00:00Z');

/**
 * The DingTalk Authorize Flow adapter (ADR-0015): provider identity (the
 * dingtalk_docs connector, connection name 'dingtalk') and the DingTalk
 * profile — login.dingtalk.com URL shape, client-id-bound code exchange
 * (no redirect_uri on the token call), caller-error classification —
 * against the mock DingTalk server. The state machine is owned by
 * test/oauth/authorize-flow.test.ts; this suite covers what only DingTalk
 * can decide.
 */
describe('DingTalk authorize flow (adapter)', () => {
  let server: ServerType;
  let mock: MockDingTalkServer;
  let oauth: DingTalkOAuthClient;
  let now: number;
  let credsStore: InMemoryDingTalkCredsStore;
  let tokenStore: InMemoryTokenStore;
  let repo: InMemoryAdminRepository;
  let flow: OAuthFlow;
  /** The exchangeCode invocations the flow adapter made (spy over the real client). */
  const exchanges = new Array<{ creds: { appKey: string; appSecret: string }; code: string }>();

  beforeEach(async () => {
    now = START;
    exchanges.length = 0;
    mock = new MockDingTalkServer({ appKey: APP_KEY, appSecret: APP_SECRET });
    server = serve({ fetch: mock.app.fetch, port: 0 });
    await new Promise((resolve) => server.once('listening', resolve));
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    oauth = createDingTalkOAuthClient({
      apiBaseUrl: baseUrl,
      authorizeBaseUrl: baseUrl,
      now: () => now,
    });
    const spyOauth: DingTalkOAuthClient = {
      ...oauth,
      exchangeCode: async (opts) => {
        exchanges.push({ creds: { ...opts.creds }, code: opts.code });
        return oauth.exchangeCode(opts);
      },
    };
    credsStore = new InMemoryDingTalkCredsStore();
    tokenStore = new InMemoryTokenStore();
    repo = new InMemoryAdminRepository();
    TENANT = (await repo.createTenant('flow-tenant')).id;
    credsStore.set(TENANT, { appKey: APP_KEY, appSecret: APP_SECRET });
    repo.addConnection(TENANT, 'existing-conn');
    flow = createDingTalkOAuthFlow({
      credsStore,
      tokenStore,
      oauth: spyOauth,
      connections: repo,
      masterKey: MASTER_KEY,
      now: () => now,
    });
  });

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it('start returns a DingTalk authorize URL carrying client_id, redirect_uri and state', async () => {
    const { authorizationUrl } = await flow.start(TENANT, REDIRECT_URI);
    const url = new URL(authorizationUrl);
    expect(url.pathname).toBe('/oauth2/auth');
    expect(url.searchParams.get('client_id')).toBe(APP_KEY);
    expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT_URI);
    expect(url.searchParams.get('state')).toBeTruthy();
  });

  it('start fails with 400 when the tenant has no DingTalk credentials', async () => {
    await expect(flow.start('tenant-no-creds', REDIRECT_URI)).rejects.toBeInstanceOf(FlowError);
    await expect(flow.start('tenant-no-creds', REDIRECT_URI)).rejects.toMatchObject({
      status: 400,
      message: 'Tenant "tenant-no-creds" has no DingTalk credentials configured (set-dingtalk-creds)',
    });
  });

  it('callback creates a dingtalk_docs connection and stores encrypted tokens', async () => {
    const { authorizationUrl } = await flow.start(TENANT, REDIRECT_URI);
    const state = new URL(authorizationUrl).searchParams.get('state')!;
    const code = await mock.authorizeCode(REDIRECT_URI, state);

    await flow.handleCallback(code, state);

    const created = repo.listConnectionsSync(TENANT).find((c) => c.name === 'dingtalk')!;
    expect(created.connectorId).toBe('dingtalk_docs');
    expect(created.oauthRedirectUri).toBe(REDIRECT_URI);

    const stored = tokenStore.list()[0]!;
    expect(stored.connectionId).toBe(created.id);
    expect(stored.accessTokenCiphertext.startsWith('v1:')).toBe(true);
    expect(decryptValue(TENANT, stored.accessTokenCiphertext, MASTER_KEY)).toBeTruthy();
  });

  it('exchanges the code with the client id only — no redirect_uri on the token call', async () => {
    const { authorizationUrl } = await flow.start(TENANT, REDIRECT_URI);
    const state = new URL(authorizationUrl).searchParams.get('state')!;
    const code = await mock.authorizeCode(REDIRECT_URI, state);

    await flow.handleCallback(code, state);

    expect(exchanges).toHaveLength(1);
    expect(exchanges[0]).toEqual({
      creds: { appKey: APP_KEY, appSecret: APP_SECRET },
      code,
    });
  });

  it('rejects an unknown or consumed state with 400', async () => {
    await expect(flow.handleCallback('code', 'no-such-state')).rejects.toMatchObject({
      status: 400,
    });
  });

  it('maps a rejected code to a 400 flow error', async () => {
    const { authorizationUrl } = await flow.start(TENANT, REDIRECT_URI);
    const state = new URL(authorizationUrl).searchParams.get('state')!;
    await expect(flow.handleCallback('bad-code', state)).rejects.toMatchObject({ status: 400 });
  });

  it('re-authorizes an existing connection in place when given connectionId', async () => {
    const { authorizationUrl } = await flow.start(TENANT, REDIRECT_URI, {
      connectionId: 'existing-conn',
    });
    const state = new URL(authorizationUrl).searchParams.get('state')!;
    const code = await mock.authorizeCode(REDIRECT_URI, state);

    await flow.handleCallback(code, state);

    const stored = tokenStore.list()[0]!;
    expect(stored.connectionId).toBe('existing-conn');
    // No new connection was created (the pre-seeded one is the only row).
    expect(repo.listConnectionsSync(TENANT)).toHaveLength(1);
  });
});
