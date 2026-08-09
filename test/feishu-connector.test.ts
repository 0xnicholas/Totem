import { serve, type ServerType } from '@hono/node-server';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFeishuOAuthClient } from '../src/feishu/oauth.js';
import { FeishuConnector } from '../src/feishu/connector.js';
import { DOCS_ACTIONS, createActionExecutor } from '../src/index.js';
import { InMemoryAllowlistStore, InMemoryAuditSink } from '../src/testing/memory-governance.js';
import { MockFeishuServer } from '../src/testing/mock-feishu-server.js';

const APP_ID = 'conn_app_id';
const APP_SECRET = 'conn_app_secret';
const REDIRECT_URI = 'https://totem.example.com/oauth/callback/feishu';
const TENANT = 'tenant-conn';
const CONNECTION = 'conn-feishu';

/**
 * The real Feishu connector (T7, Seam B): the first actual translator in
 * the system. Its handlers call the Feishu Docs API with the connection's
 * access token and map Feishu request/response shapes and error codes into
 * the unified action vocabulary — all against the mock server, no real
 * Feishu credentials.
 */
describe('FeishuConnector (Seam B)', () => {
  let server: ServerType;
  let baseUrl: string;
  let mock: MockFeishuServer;
  let accessToken: string;
  let connector: FeishuConnector;

  beforeAll(async () => {
    mock = new MockFeishuServer({ appId: APP_ID, appSecret: APP_SECRET });
    mock.seedDocs([
      {
        doc_id: 'doc-1',
        title: 'Product Strategy',
        content: '# Strategy\n\nFocus on the action layer.',
        owner_id: 'user-9',
        doc_type: 'docx',
        edited_at: '2026-03-01T10:00:00.000Z',
      },
      {
        doc_id: 'doc-2',
        title: 'Notes',
        content: 'Scattered thoughts.',
        owner_id: 'user-9',
        doc_type: 'docx',
        edited_at: '2026-01-01T10:00:00.000Z',
      },
    ]);
    server = serve({ fetch: mock.app.fetch, port: 0 });
    await new Promise((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const oauth = createFeishuOAuthClient(baseUrl);
    const pair = await oauth.exchangeCode({
      creds: { appId: APP_ID, appSecret: APP_SECRET },
      code: await mock.authorizeCode(REDIRECT_URI, 'st-conn'),
      redirectUri: REDIRECT_URI,
    });
    accessToken = pair.accessToken;
    connector = new FeishuConnector(baseUrl);
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  const ctx = { tenantId: TENANT, connectionId: CONNECTION, token: '' };

  it('search_docs maps query + page size to the Feishu request and unifies the output', async () => {
    ctx.token = accessToken;
    const output = await connector.execute('search_docs', { query: 'strategy' }, ctx);
    expect(output).toEqual({ docs: [{ doc_id: 'doc-1', title: 'Product Strategy', doc_type: 'docx' }] });

    const limited = await connector.execute('search_docs', { query: '', limit: 1 }, ctx);
    expect(limited).toEqual({ docs: [{ doc_id: 'doc-1', title: 'Product Strategy', doc_type: 'docx' }] });
  });

  it('get_doc_content returns the raw content in a stable structure', async () => {
    ctx.token = accessToken;
    const output = await connector.execute('get_doc_content', { doc_id: 'doc-1' }, ctx);
    expect(output).toEqual({
      doc_id: 'doc-1',
      content: '# Strategy\n\nFocus on the action layer.',
    });
  });

  it('get_doc_metadata returns title, owner, doc type and edit time', async () => {
    ctx.token = accessToken;
    const output = await connector.execute('get_doc_metadata', { doc_id: 'doc-2' }, ctx);
    expect(output).toEqual({
      doc_id: 'doc-2',
      title: 'Notes',
      owner_id: 'user-9',
      doc_type: 'docx',
      edited_at: '2026-01-01T10:00:00.000Z',
    });
  });

  it('maps a missing document to not_found with upstream diagnostics', async () => {
    ctx.token = accessToken;
    const err = await connector
      .execute('get_doc_content', { doc_id: 'doc-nope' }, ctx)
      .then(() => undefined, (e: unknown) => e);
    expect(err).toMatchObject({
      code: 'not_found',
      retryable: false,
      upstream: { code: '10662' },
    });
  });

  it('maps permission denied to upstream_error (the closest vocabulary fit)', async () => {
    mock.failNextDocs({ code: 91672, msg: 'permission denied' });
    ctx.token = accessToken;
    const err = await connector
      .execute('get_doc_content', { doc_id: 'doc-1' }, ctx)
      .then(() => undefined, (e: unknown) => e);
    expect(err).toMatchObject({
      code: 'upstream_error',
      retryable: false,
      upstream: { code: '91672', message: 'permission denied' },
    });
  });

  it('maps Feishu rate limits to rate_limited (retryable)', async () => {
    mock.failNextDocs({ code: 99991400, msg: 'rate limit', httpStatus: 429 });
    ctx.token = accessToken;
    const err = await connector
      .execute('get_doc_content', { doc_id: 'doc-1' }, ctx)
      .then(() => undefined, (e: unknown) => e);
    expect(err).toMatchObject({ code: 'rate_limited', retryable: true });
  });

  it('signals auth_expired when Feishu rejects the access token mid-call', async () => {
    ctx.token = 'stale-token';
    const err = await connector
      .execute('search_docs', { query: 'q' }, ctx)
      .then(() => undefined, (e: unknown) => e);
    expect(err).toMatchObject({ code: 'auth_expired', retryable: false });
  });

  it('wraps network failures as upstream_error', async () => {
    const offline = new FeishuConnector('http://127.0.0.1:1');
    const err = await offline
      .execute('search_docs', { query: 'q' }, { ...ctx, token: accessToken })
      .then(() => undefined, (e: unknown) => e);
    expect(err).toMatchObject({ code: 'upstream_error', retryable: false });
  });
});

/**
 * Seam A + Seam B joined: the same executor path the MCP server uses,
 * with the real connector and a TokenProvider handing out an issued
 * token. Governance (allowlist + audit) applies to the new actions.
 */
describe('FeishuConnector through the executor (Seam A + B)', () => {
  let server: ServerType;
  let baseUrl: string;
  let mock: MockFeishuServer;
  let accessToken: string;

  beforeAll(async () => {
    mock = new MockFeishuServer({ appId: APP_ID, appSecret: APP_SECRET });
    mock.seedDocs([
      {
        doc_id: 'doc-x',
        title: 'Governed Doc',
        content: 'content here',
        owner_id: 'user-9',
        doc_type: 'docx',
        edited_at: '2026-03-01T10:00:00.000Z',
      },
    ]);
    server = serve({ fetch: mock.app.fetch, port: 0 });
    await new Promise((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const oauth = createFeishuOAuthClient(baseUrl);
    const pair = await oauth.exchangeCode({
      creds: { appId: APP_ID, appSecret: APP_SECRET },
      code: await mock.authorizeCode(REDIRECT_URI, 'st-exec'),
      redirectUri: REDIRECT_URI,
    });
    accessToken = pair.accessToken;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  function makeExecutor(allowlist: string[]) {
    const allowlists = new InMemoryAllowlistStore();
    allowlists.setAllowed(TENANT, CONNECTION, allowlist);
    const audit = new InMemoryAuditSink();
    const executor = createActionExecutor({
      actions: DOCS_ACTIONS,
      connectors: [new FeishuConnector(baseUrl)],
      connections: [{ tenantId: TENANT, connectionId: CONNECTION, connectorId: 'feishu_docs' }],
      allowlists,
      audit,
      tokenProvider: { getValidAccessToken: () => Promise.resolve(accessToken) },
    });
    return { executor, audit };
  }

  it('executes search_docs with audit, and rejects disallowed reads with forbidden', async () => {
    const { executor, audit } = makeExecutor(['search_docs']);

    const ok = await executor.executeAction(TENANT, CONNECTION, 'search_docs', { query: 'governed' });
    expect(ok).toMatchObject({ ok: true, output: { docs: [{ doc_id: 'doc-x', title: 'Governed Doc' }] } });

    const denied = await executor.executeAction(TENANT, CONNECTION, 'get_doc_metadata', {
      doc_id: 'doc-x',
    });
    expect(denied).toMatchObject({ ok: false, error: { code: 'forbidden' } });

    expect(audit.list().map((r) => [r.actionName, r.success, r.errorCode])).toEqual([
      ['search_docs', true, null],
      ['get_doc_metadata', false, 'forbidden'],
    ]);
  });

  it('surfaces connector-mapped errors through executeAction', async () => {
    const { executor } = makeExecutor(['get_doc_content']);
    const missing = await executor.executeAction(TENANT, CONNECTION, 'get_doc_content', {
      doc_id: 'doc-nope',
    });
    expect(missing).toMatchObject({ ok: false, error: { code: 'not_found' } });
  });
});
