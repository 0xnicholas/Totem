import { serve, type ServerType } from '@hono/node-server';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decryptValue } from '../src/feishu/crypto.js';
import { createFeishuOAuthClient, type FeishuOAuthClient } from '../src/feishu/oauth.js';
import { createOAuthFlow, FlowError, type OAuthFlow } from '../src/feishu/flow.js';
import { InMemoryAdminRepository } from '../src/testing/memory-admin-repo.js';
import {
  InMemoryFeishuCredsStore,
  InMemoryTokenStore,
} from '../src/testing/memory-feishu.js';
import { MockFeishuServer } from '../src/testing/mock-feishu-server.js';

const APP_ID = 'flow_app_id';
const APP_SECRET = 'flow_app_secret';
const MASTER_KEY = 'test-master-key-0123456789abcdef';
let TENANT: string;
const REDIRECT_URI = 'https://totem.example.com/oauth/callback/feishu';
const START = Date.parse('2026-01-01T00:00:00Z');

/**
 * The OAuth flow (T6 AC-1): the admin starts the flow (authorization URL
 * with state), the user authorizes in Feishu, and the callback exchanges
 * the code, creates the connection record (owner server-set, redirect URI
 * recorded for re-auth) and stores the tokens encrypted. All against the
 * mock Feishu server — no real credentials.
 */
describe('OAuthFlow', () => {
  let server: ServerType;
  let mock: MockFeishuServer;
  let oauth: FeishuOAuthClient;
  let now: number;
  let credsStore: InMemoryFeishuCredsStore;
  let tokenStore: InMemoryTokenStore;
  let repo: InMemoryAdminRepository;
  let flow: OAuthFlow;

  beforeEach(async () => {
    now = START;
    mock = new MockFeishuServer({ appId: APP_ID, appSecret: APP_SECRET });
    server = serve({ fetch: mock.app.fetch, port: 0 });
    await new Promise((resolve) => server.once('listening', resolve));
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    oauth = createFeishuOAuthClient(baseUrl, () => now);
    credsStore = new InMemoryFeishuCredsStore();
    tokenStore = new InMemoryTokenStore();
    repo = new InMemoryAdminRepository();
    TENANT = (await repo.createTenant('flow-tenant')).id;
    credsStore.set(TENANT, { appId: APP_ID, appSecret: APP_SECRET });
    repo.addConnection(TENANT, 'existing-conn');
    flow = createOAuthFlow({
      credsStore,
      tokenStore,
      oauth,
      connections: repo,
      masterKey: MASTER_KEY,
      now: () => now,
    });
  });

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it('start returns an authorization URL carrying app_id, redirect_uri and state', async () => {
    const { authorizationUrl } = await flow.start(TENANT, REDIRECT_URI);
    const url = new URL(authorizationUrl);
    expect(url.pathname).toBe('/open-apis/authen/v1/authorize');
    expect(url.searchParams.get('app_id')).toBe(APP_ID);
    expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT_URI);
    expect(url.searchParams.get('state')).toBeTruthy();
  });

  it('start fails with 400 when the tenant has no Feishu credentials', async () => {
    await expect(flow.start('tenant-no-creds', REDIRECT_URI)).rejects.toBeInstanceOf(FlowError);
    await expect(flow.start('tenant-no-creds', REDIRECT_URI)).rejects.toMatchObject({
      status: 400,
    });
  });

  it('callback exchanges the code, creates the connection and stores encrypted tokens', async () => {
    const { authorizationUrl } = await flow.start(TENANT, REDIRECT_URI);
    const state = new URL(authorizationUrl).searchParams.get('state')!;
    const code = await mock.authorizeCode(REDIRECT_URI, state);

    await flow.handleCallback(code, state);

    // The connection record: owner server-set, redirect recorded, active.
    const connections = repo.listConnectionsSync(TENANT);
    const created = connections.find((c) => c.id !== 'existing-conn');
    expect(created).toMatchObject({
      tenantId: TENANT,
      connectorId: 'feishu_docs',
      name: 'feishu',
      status: 'active',
      ownerId: TENANT,
      oauthRedirectUri: REDIRECT_URI,
    });

    // Tokens stored encrypted with the per-tenant key; expiry matches the
    // mock's access-token TTL (2h default).
    const stored = tokenStore.list()[0]!;
    expect(stored.connectionId).toBe(created!.id);
    expect(stored.accessTokenCiphertext.startsWith('v1:')).toBe(true);
    expect(decryptValue(TENANT, stored.accessTokenCiphertext, MASTER_KEY)).toMatch(/^mock_access_/);
    expect(decryptValue(TENANT, stored.refreshTokenCiphertext, MASTER_KEY)).toMatch(
      /^mock_refresh_/,
    );
    expect(stored.expiresAt).toBe(new Date(START + 2 * 60 * 60 * 1000).toISOString());
  });

  it('rejects an unknown or consumed state with 400 and creates nothing', async () => {
    const unknownErr = await flow
      .handleCallback('some-code', 'never-issued')
      .catch((e: unknown) => e);
    expect(unknownErr).toBeInstanceOf(FlowError);
    expect(unknownErr).toMatchObject({ status: 400 });

    const { authorizationUrl } = await flow.start(TENANT, REDIRECT_URI);
    const state = new URL(authorizationUrl).searchParams.get('state')!;
    const code = await mock.authorizeCode(REDIRECT_URI, state);
    await flow.handleCallback(code, state);
    // Replay of the same state (e.g. a retried browser redirect) fails.
    const replayErr = await flow.handleCallback(code, state).catch((e: unknown) => e);
    expect(replayErr).toBeInstanceOf(FlowError);
    expect(replayErr).toMatchObject({ status: 400 });
    expect(tokenStore.list()).toHaveLength(1);
  });

  it('rejects expired states with 400 (state TTL)', async () => {
    const { authorizationUrl } = await flow.start(TENANT, REDIRECT_URI);
    const state = new URL(authorizationUrl).searchParams.get('state')!;
    now += 11 * 60 * 1000; // 11 minutes later; default TTL is 10

    const code = await mock.authorizeCode(REDIRECT_URI, state);
    await expect(flow.handleCallback(code, state)).rejects.toMatchObject({
      name: 'FlowError',
      status: 400,
    });
    expect(tokenStore.list()).toHaveLength(0);
  });

  it('rejects a bad authorization code with 400', async () => {
    const { authorizationUrl } = await flow.start(TENANT, REDIRECT_URI);
    const state = new URL(authorizationUrl).searchParams.get('state')!;

    await expect(flow.handleCallback('never-issued-code', state)).rejects.toMatchObject({
      name: 'FlowError',
      status: 400,
    });
    expect(tokenStore.list()).toHaveLength(0);
  });

  it('a second flow creates a second connection (multi-connection)', async () => {
    const first = await flow.start(TENANT, REDIRECT_URI);
    await flow.handleCallback(
      await mock.authorizeCode(REDIRECT_URI, new URL(first.authorizationUrl).searchParams.get('state')!),
      new URL(first.authorizationUrl).searchParams.get('state')!,
    );
    const second = await flow.start(TENANT, REDIRECT_URI);
    await flow.handleCallback(
      await mock.authorizeCode(REDIRECT_URI, new URL(second.authorizationUrl).searchParams.get('state')!),
      new URL(second.authorizationUrl).searchParams.get('state')!,
    );

    const connections = repo.listConnectionsSync(TENANT).filter((c) => c.id !== 'existing-conn');
    expect(connections).toHaveLength(2);
    expect(new Set(connections.map((c) => c.id)).size).toBe(2);
  });

  it('re-authorizes an existing connection in place (auth_expired → active)', async () => {
    const first = await flow.start(TENANT, REDIRECT_URI);
    const firstState = new URL(first.authorizationUrl).searchParams.get('state')!;
    await flow.handleCallback(await mock.authorizeCode(REDIRECT_URI, firstState), firstState);
    const created = repo
      .listConnectionsSync(TENANT)
      .find((c) => c.id !== 'existing-conn')!;
    await repo.suspendConnection(created.id, true); // simulate auth_expired-ish state
    const beforeCiphertext = tokenStore.list()[0]!.accessTokenCiphertext;

    const reauth = await flow.start(TENANT, REDIRECT_URI, { connectionId: created.id });
    const reauthState = new URL(reauth.authorizationUrl).searchParams.get('state')!;
    await flow.handleCallback(await mock.authorizeCode(REDIRECT_URI, reauthState), reauthState);

    // Same connection, reactivated; tokens replaced; no new connection.
    const after = repo.listConnectionsSync(TENANT).filter((c) => c.id !== 'existing-conn');
    expect(after).toHaveLength(1);
    expect(after[0]?.id).toBe(created.id);
    expect(after[0]?.status).toBe('active');
    const stored = tokenStore.list()[0]!;
    expect(stored.connectionId).toBe(created.id);
    // Tokens were replaced by the re-authorization.
    expect(stored.accessTokenCiphertext).not.toBe(beforeCiphertext);
    expect(decryptValue(TENANT, stored.refreshTokenCiphertext, MASTER_KEY)).toMatch(
      /^mock_refresh_/,
    );
  });
});
