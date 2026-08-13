import { serve, type ServerType } from '@hono/node-server';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decryptValue } from '../src/crypto.js';
import { createFeishuOAuthClient, type FeishuOAuthClient } from '../src/feishu/oauth.js';
import { createFeishuOAuthFlow } from '../src/feishu/flows.js';
import { FlowError, type OAuthFlow } from '../src/oauth/authorize-flow.js';
import { InMemoryAdminRepository } from '../src/testing/memory-admin-repo.js';
import { InMemoryFeishuCredsStore } from '../src/testing/memory-feishu.js';
import { InMemoryTokenStore } from '../src/testing/memory-oauth.js';
import { MockFeishuServer } from '../src/testing/mock-feishu-server.js';

const APP_ID = 'flow_app_id';
const APP_SECRET = 'flow_app_secret';
const MASTER_KEY = 'test-master-key-0123456789abcdef';
let TENANT: string;
const REDIRECT_URI = 'https://totem.example.com/oauth/callback/feishu';
const START = Date.parse('2026-01-01T00:00:00Z');

/**
 * The Feishu Authorize Flow adapter (ADR-0015): provider identity (the
 * feishu_docs connector, connection name 'feishu') and the Feishu profile
 * — authorize URL shape, redirect-bound code exchange, caller-error
 * classification — against the mock Feishu server. The state machine is
 * owned by test/oauth/authorize-flow.test.ts; this suite covers what only
 * Feishu can decide.
 */
describe('Feishu authorize flow (adapter)', () => {
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
    oauth = createFeishuOAuthClient(baseUrl, { now: () => now });
    credsStore = new InMemoryFeishuCredsStore();
    tokenStore = new InMemoryTokenStore();
    repo = new InMemoryAdminRepository();
    TENANT = (await repo.createTenant('flow-tenant')).id;
    credsStore.set(TENANT, { appId: APP_ID, appSecret: APP_SECRET });
    repo.addConnection(TENANT, 'existing-conn');
    flow = createFeishuOAuthFlow({
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

  it('start returns a Feishu authorize URL carrying app_id, redirect_uri and state', async () => {
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
      message: 'Tenant "tenant-no-creds" has no Feishu credentials configured (set-feishu-creds)',
    });
  });

  it('callback creates a feishu_docs connection named feishu and stores encrypted tokens', async () => {
    const { authorizationUrl } = await flow.start(TENANT, REDIRECT_URI);
    const state = new URL(authorizationUrl).searchParams.get('state')!;
    const code = await mock.authorizeCode(REDIRECT_URI, state);

    await flow.handleCallback(code, state);

    const created = repo.listConnectionsSync(TENANT).find((c) => c.id !== 'existing-conn');
    expect(created).toMatchObject({
      tenantId: TENANT,
      connectorId: 'feishu_docs',
      name: 'feishu',
      status: 'active',
      ownerId: TENANT,
      oauthRedirectUri: REDIRECT_URI,
    });

    const stored = tokenStore.list()[0]!;
    expect(stored.connectionId).toBe(created!.id);
    expect(stored.accessTokenCiphertext.startsWith('v1:')).toBe(true);
    expect(decryptValue(TENANT, stored.accessTokenCiphertext, MASTER_KEY)).toMatch(/^mock_access_/);
    expect(stored.expiresAt).toBe(new Date(START + 2 * 60 * 60 * 1000).toISOString());
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

  it('re-authorizes an existing connection in place (auth_expired → active)', async () => {
    const { authorizationUrl } = await flow.start(TENANT, REDIRECT_URI, {
      connectionId: 'existing-conn',
    });
    const state = new URL(authorizationUrl).searchParams.get('state')!;
    await flow.handleCallback(await mock.authorizeCode(REDIRECT_URI, state), state);

    // No new connection; tokens replaced on the existing row.
    expect(repo.listConnectionsSync(TENANT)).toHaveLength(1);
    const stored = tokenStore.list()[0]!;
    expect(stored.connectionId).toBe('existing-conn');
    expect(decryptValue(TENANT, stored.refreshTokenCiphertext, MASTER_KEY)).toMatch(
      /^mock_refresh_/,
    );
  });
});
