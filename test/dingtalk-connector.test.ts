import { serve, type ServerType } from '@hono/node-server';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CONNECTION_ACTIONS, DOCS_ACTIONS, createActionExecutor } from '../src/index.js';
import { DingTalkConnector } from '../src/dingtalk/connector.js';
import { createDingTalkOAuthClient } from '../src/dingtalk/oauth.js';
import { InMemoryAllowlistStore, InMemoryAuditSink } from '../src/testing/memory-governance.js';
import { MockDingTalkServer } from '../src/testing/mock-dingtalk-server.js';

const APP_KEY = 'conn_app_key';
const APP_SECRET = 'conn_app_secret';
const REDIRECT_URI = 'https://totem.example.com/oauth/callback/dingtalk';
const TENANT = 'tenant-conn';
const CONNECTION = 'conn-dingtalk';

/**
 * The real DingTalk connector (T17a, Seam B): the connection skeleton —
 * `test_connection`, the cheapest live proof (the identity API), with
 * DingTalk failures mapped into the unified action vocabulary. Tested
 * against the mock server, no real DingTalk credentials; plus a Seam A
 * slice proving the action executes through the execution boundary with
 * the same governance as Feishu connections.
 */
describe('DingTalkConnector (Seam B)', () => {
  let server: ServerType;
  let baseUrl: string;
  let mock: MockDingTalkServer;
  let connector: DingTalkConnector;
  let accessToken: string;

  beforeAll(async () => {
    mock = new MockDingTalkServer({ appKey: APP_KEY, appSecret: APP_SECRET });
    server = serve({ fetch: mock.app.fetch, port: 0 });
    await new Promise((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    connector = new DingTalkConnector(baseUrl);

    // A real token from the mock's token endpoint, as the token manager
    // would deliver it in ActionContext.
    const oauth = createDingTalkOAuthClient({ apiBaseUrl: baseUrl, authorizeBaseUrl: baseUrl });
    const code = await mock.authorizeCode(REDIRECT_URI, 's');
    accessToken = (await oauth.exchangeCode({ creds: { appKey: APP_KEY, appSecret: APP_SECRET }, code }))
      .accessToken;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it('declares the connection skeleton manifest (test_connection only, T17a)', () => {
    expect(connector.manifest.id).toBe('dingtalk_docs');
    expect(connector.manifest.implements).toEqual(['test_connection']);
  });

  it('test_connection returns ok with a valid user access token', async () => {
    const output = await connector.execute(
      'test_connection',
      {},
      { tenantId: TENANT, connectionId: CONNECTION, token: accessToken },
    );
    expect(output).toEqual({ connection_id: CONNECTION, status: 'ok' });
  });

  it('maps a rejected access token to auth_expired', async () => {
    await expect(
      connector.execute('test_connection', {}, { tenantId: TENANT, connectionId: CONNECTION, token: 'bad' }),
    ).rejects.toMatchObject({ code: 'auth_expired', retryable: false });
  });

  it('maps a rate limit to rate_limited (retryable)', async () => {
    mock.failNext({ code: 'TooManyRequests', message: 'slow down', httpStatus: 429 });
    await expect(
      connector.execute('test_connection', {}, { tenantId: TENANT, connectionId: CONNECTION, token: accessToken }),
    ).rejects.toMatchObject({ code: 'rate_limited', retryable: true });
  });

  it('maps a network failure to upstream_error', async () => {
    const dead = new DingTalkConnector('http://127.0.0.1:1');
    await expect(
      dead.execute('test_connection', {}, { tenantId: TENANT, connectionId: CONNECTION, token: 'x' }),
    ).rejects.toMatchObject({ code: 'upstream_error' });
  });
});

/**
 * Seam A slice (T17a AC-3): the DingTalk connection runs through the
 * execution boundary with the same governance as Feishu — allowlist,
 * audit, token placement — without any change to the boundary.
 */
describe('test_connection through Seam A (governance applies unchanged)', () => {
  let server: ServerType;
  let baseUrl: string;
  let mock: MockDingTalkServer;
  let accessToken: string;

  beforeAll(async () => {
    mock = new MockDingTalkServer({ appKey: APP_KEY, appSecret: APP_SECRET });
    server = serve({ fetch: mock.app.fetch, port: 0 });
    await new Promise((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const oauth = createDingTalkOAuthClient({ apiBaseUrl: baseUrl, authorizeBaseUrl: baseUrl });
    const code = await mock.authorizeCode(REDIRECT_URI, 's');
    accessToken = (await oauth.exchangeCode({ creds: { appKey: APP_KEY, appSecret: APP_SECRET }, code }))
      .accessToken;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  function makeExecutor(opts: { allowed: string[] }) {
    const allowlists = new InMemoryAllowlistStore();
    allowlists.setAllowed(TENANT, CONNECTION, opts.allowed);
    const audit = new InMemoryAuditSink();
    const executor = createActionExecutor({
      actions: [...DOCS_ACTIONS, ...CONNECTION_ACTIONS],
      connectors: [new DingTalkConnector(baseUrl)],
      connections: [{ tenantId: TENANT, connectionId: CONNECTION, connectorId: 'dingtalk_docs' }],
      allowlists,
      audit,
      tokenProvider: { getValidAccessToken: () => Promise.resolve(accessToken) },
    });
    return { executor, audit };
  }

  it('executes test_connection when allowed, with audit', async () => {
    const { executor, audit } = makeExecutor({ allowed: ['test_connection'] });
    const result = await executor.executeAction(TENANT, CONNECTION, 'test_connection', {}, 'cli');
    expect(result).toEqual({
      ok: true,
      output: { connection_id: CONNECTION, status: 'ok' },
    });
    expect(audit.list()).toHaveLength(1);
    expect(audit.list()[0]).toMatchObject({
      tenantId: TENANT,
      connectionId: CONNECTION,
      actionName: 'test_connection',
      success: true,
      errorCode: null,
    });
  });

  it('rejects test_connection when the allowlist does not include it (fail-closed)', async () => {
    const { executor } = makeExecutor({ allowed: [] });
    const result = await executor.executeAction(TENANT, CONNECTION, 'test_connection', {}, 'cli');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('forbidden');
    }
  });

  it('rejects actions the connector does not implement (hide, don\'t reject)', async () => {
    const { executor } = makeExecutor({ allowed: ['create_doc'] });
    const result = await executor.executeAction(TENANT, CONNECTION, 'create_doc', { title: 'x' }, 'cli');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('action_not_found');
      expect(result.error.message).toContain('not available on connection');
    }
  });
});
