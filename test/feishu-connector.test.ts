import { serve, type ServerType } from '@hono/node-server';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFeishuOAuthClient, FeishuApiError } from '../src/feishu/oauth.js';
import { FeishuConnector, mapFeishuError } from '../src/feishu/connector.js';
import { CONNECTION_ACTIONS, DOCS_ACTIONS, MESSAGING_ACTIONS, createActionExecutor } from '../src/index.js';
import { InMemoryAllowlistStore, InMemoryAuditSink } from '../src/testing/memory-governance.js';
import { FakeConnector } from '../src/testing/fake-connector.js';
import { MockFeishuServer } from '../src/testing/mock-feishu-server.js';
import { CONN_1, TENANT_A, makeHarness } from './fixtures.js';

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
    connector = new FeishuConnector(baseUrl, { exportPollMs: 0 });
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  const ctx = { tenantId: TENANT, connectionId: CONNECTION, token: '' };

  it('declares its provider scope in the manifest (ADR-0013)', () => {
    expect(connector.manifest.id).toBe('feishu_docs');
    expect(connector.manifest.provider).toBe('feishu');
    expect(connector.manifest.implements).toContain('feishu_read_bitable_records');
    expect(connector.manifest.implements).toContain('feishu_write_bitable_records');
  });

  it('search_docs maps query + page size to the Feishu request and unifies the output', async () => {
    ctx.token = accessToken;
    const output = await connector.execute('search_docs', { query: 'strategy' }, ctx);
    expect(output).toEqual({ data: [{ doc_id: 'doc-1', title: 'Product Strategy', doc_type: 'docx' }], next: null });

    const limited = await connector.execute('search_docs', { query: '', limit: 1 }, ctx);
    expect(limited).toEqual({ data: [{ doc_id: 'doc-1', title: 'Product Strategy', doc_type: 'docx' }], next: '1' });

    // #42: a non-null next cursor fetches the next page.
    const page2 = await connector.execute('search_docs', { query: '', limit: 1, page_token: '1' }, ctx);
    expect(page2).toEqual({ data: [{ doc_id: 'doc-2', title: 'Notes', doc_type: 'docx' }], next: null });
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

  it('test_connection probes the drive and reports the connection ok (T10)', async () => {
    ctx.token = accessToken;
    const output = await connector.execute('test_connection', {}, ctx);
    expect(output).toEqual({ connection_id: CONNECTION, status: 'ok' });
  });

  it('test_connection maps a stale token to auth_expired (T10)', async () => {
    ctx.token = 'stale-token';
    const err = await connector
      .execute('test_connection', {}, ctx)
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

  it('send_message addresses a user by email and returns the message id (ADR-0016)', async () => {
    ctx.token = accessToken;
    const result = await connector.execute(
      'send_message',
      { email: 'zhangsan@corp.com', content: 'daily report ready' },
      ctx,
    );
    const output = result as { message_id: string };
    expect(output.message_id).toMatch(/^om_/);
    expect(mock.sentMessages).toEqual([
      {
        receiveIdType: 'email',
        receiveId: 'zhangsan@corp.com',
        content: 'daily report ready',
      },
    ]);
  });

  it('send_message addresses a chat by opaque chat_id', async () => {
    const result = await connector.execute(
      'send_message',
      { chat_id: 'oc_chat-1', content: 'heads up' },
      ctx,
    );
    const output = result as { message_id: string };
    expect(output.message_id).toMatch(/^om_/);
    expect(mock.sentMessages[1]).toEqual({
      receiveIdType: 'chat_id',
      receiveId: 'oc_chat-1',
      content: 'heads up',
    });
  });

  it('send_message maps a rate limit to rate_limited (retryable)', async () => {
    mock.failNextDocs({ code: 99991400, msg: 'rate limited' });
    const err = await connector
      .execute('send_message', { email: 'a@b.co', content: 'x' }, ctx)
      .then(() => undefined, (e: unknown) => e);
    expect(err).toMatchObject({ code: 'rate_limited', retryable: true });
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
      actions: [...DOCS_ACTIONS, ...MESSAGING_ACTIONS, ...CONNECTION_ACTIONS],
      connectors: [new FeishuConnector(baseUrl, { exportPollMs: 0 })],
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
    expect(ok).toMatchObject({ ok: true, output: { data: [{ doc_id: 'doc-x', title: 'Governed Doc' }], next: null } });

    const denied = await executor.executeAction(TENANT, CONNECTION, 'get_doc_metadata', {
      doc_id: 'doc-x',
    });
    expect(denied).toMatchObject({ ok: false, error: { code: 'forbidden' } });

    expect(audit.list().map((r) => [r.actionName, r.success, r.errorCode])).toEqual([
      ['search_docs', true, null],
      ['get_doc_metadata', false, 'forbidden'],
    ]);
  });

  it('executes send_message with audit, and rejects disallowed sends with forbidden (ADR-0016)', async () => {
    const { executor, audit } = makeExecutor(['send_message']);

    const ok = await executor.executeAction(TENANT, CONNECTION, 'send_message', {
      email: 'zhangsan@corp.com',
      content: 'governed message',
    });
    if (!ok.ok) throw new Error('expected send to succeed');
    const output = ok.output as { message_id: string };
    expect(output.message_id).toMatch(/^om_/);

    const denied = await executor.executeAction(TENANT, CONNECTION, 'search_docs', {
      query: 'governed',
    });
    expect(denied).toMatchObject({ ok: false, error: { code: 'forbidden' } });

    expect(audit.list().map((r) => [r.actionName, r.success, r.errorCode])).toEqual([
      ['send_message', true, null],
      ['search_docs', false, 'forbidden'],
    ]);
  });

  it('rejects send_message addressing with validation_error when both or neither of email/chat_id are given', async () => {
    const { executor } = makeExecutor(['send_message']);

    const both = await executor.executeAction(TENANT, CONNECTION, 'send_message', {
      email: 'a@b.co',
      chat_id: 'oc_x',
      content: 'x',
    });
    expect(both).toMatchObject({ ok: false, error: { code: 'validation_error' } });

    const neither = await executor.executeAction(TENANT, CONNECTION, 'send_message', {
      content: 'x',
    });
    expect(neither).toMatchObject({ ok: false, error: { code: 'validation_error' } });
  });

  it('rejects send_message with an explicit null recipient at the boundary, not as an upstream failure (#56)', async () => {
    // The exactly-one-of oneOf keys on property PRESENCE, so {email: null}
    // used to validate and surface as an opaque upstream error — the
    // schema now rejects null addressing as validation_error for every
    // connector (rationale in sendMessageInputSchema's comment).
    const { executor } = makeExecutor(['send_message']);

    const nullEmail = await executor.executeAction(TENANT, CONNECTION, 'send_message', {
      email: null,
      content: 'x',
    });
    expect(nullEmail).toMatchObject({ ok: false, error: { code: 'validation_error', retryable: false } });

    const nullChat = await executor.executeAction(TENANT, CONNECTION, 'send_message', {
      chat_id: null,
      content: 'x',
    });
    expect(nullChat).toMatchObject({ ok: false, error: { code: 'validation_error', retryable: false } });
  });

  it('surfaces connector-mapped errors through executeAction', async () => {
    const { executor } = makeExecutor(['get_doc_content']);
    const missing = await executor.executeAction(TENANT, CONNECTION, 'get_doc_content', {
      doc_id: 'doc-nope',
    });
    expect(missing).toMatchObject({ ok: false, error: { code: 'not_found' } });
  });

  it('test_connection runs through the executor with allowlist + audit (T10)', async () => {
    const { executor, audit } = makeExecutor(['test_connection']);

    const ok = await executor.executeAction(TENANT, CONNECTION, 'test_connection', {});
    expect(ok).toMatchObject({ ok: true, output: { connection_id: CONNECTION, status: 'ok' } });
    expect(audit.list()[0]).toMatchObject({
      actionName: 'test_connection',
      success: true,
      errorCode: null,
    });

    const denied = await executor.executeAction(TENANT, CONNECTION, 'search_docs', {
      query: 'x',
    });
    expect(denied).toMatchObject({ ok: false, error: { code: 'forbidden' } });
  });
});

/**
 * The write side of the real connector (T8): create, append (via Feishu's
 * blocks API), rename and move, with the same error mapping as reads.
 */
describe('FeishuConnector write actions (T8)', () => {
  let server: ServerType;
  let baseUrl: string;
  let mock: MockFeishuServer;
  let accessToken: string;
  let connector: FeishuConnector;

  beforeAll(async () => {
    mock = new MockFeishuServer({ appId: APP_ID, appSecret: APP_SECRET });
    mock.seedDocs([
      {
        doc_id: 'w-1',
        title: 'Write Target',
        content: 'First line.',
        owner_id: 'user-9',
        doc_type: 'docx',
        edited_at: '2026-03-01T10:00:00.000Z',
      },
      {
        doc_id: 'w-2',
        title: 'Styled Title',
        content: 'Body.',
        owner_id: 'user-9',
        doc_type: 'docx',
        edited_at: '2026-03-01T10:00:00.000Z',
        root_elements: [
          { text_run: { content: 'Styled', text_element_style: { bold: true } } },
          { text_run: { content: ' Title' } },
        ],
      },
    ]);
    server = serve({ fetch: mock.app.fetch, port: 0 });
    await new Promise((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const oauth = createFeishuOAuthClient(baseUrl);
    const pair = await oauth.exchangeCode({
      creds: { appId: APP_ID, appSecret: APP_SECRET },
      code: await mock.authorizeCode(REDIRECT_URI, 'st-write'),
      redirectUri: REDIRECT_URI,
    });
    accessToken = pair.accessToken;
    connector = new FeishuConnector(baseUrl, { exportPollMs: 0, movePollMs: 0 });
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  const ctx = { tenantId: TENANT, connectionId: CONNECTION, token: '' };

  it('create_doc creates a document and returns id + title', async () => {
    ctx.token = accessToken;
    const output = await connector.execute(
      'create_doc',
      { title: 'Fresh Doc', folder_id: 'folder-1', content: 'Seed.' },
      ctx,
    );
    expect(output).toMatchObject({ title: 'Fresh Doc' });
    const created = output as { doc_id: string };
    expect(created.doc_id).toBeTruthy();

    // The created doc is readable back through the connector.
    const content = await connector.execute('get_doc_content', { doc_id: created.doc_id }, ctx);
    expect(content).toEqual({ doc_id: created.doc_id, content: 'Seed.' });
  });

  it('append_doc_content appends and returns the full updated content', async () => {
    ctx.token = accessToken;
    const output = await connector.execute(
      'append_doc_content',
      { doc_id: 'w-1', content: 'Second line.' },
      ctx,
    );
    expect(output).toEqual({ doc_id: 'w-1', content: 'First line.\nSecond line.' });
  });

  it('rename_doc renames and returns the new title', async () => {
    ctx.token = accessToken;
    const output = await connector.execute('rename_doc', { doc_id: 'w-1', new_title: 'Renamed' }, ctx);
    expect(output).toEqual({ doc_id: 'w-1', title: 'Renamed' });

    const metadata = await connector.execute('get_doc_metadata', { doc_id: 'w-1' }, ctx);
    expect(metadata).toMatchObject({ doc_id: 'w-1', title: 'Renamed' });
  });

  it('move_doc moves and returns the target folder', async () => {
    ctx.token = accessToken;
    const output = await connector.execute('move_doc', { doc_id: 'w-1', folder_id: 'folder-9' }, ctx);
    expect(output).toEqual({ doc_id: 'w-1', folder_id: 'folder-9' });
  });

  it('move_doc polls a pending move task until it completes (#41)', async () => {
    ctx.token = accessToken;
    mock.holdNextMove();
    const output = await connector.execute(
      'move_doc',
      { doc_id: 'w-1', folder_id: 'folder-10' },
      ctx,
    );
    expect(output).toEqual({ doc_id: 'w-1', folder_id: 'folder-10' });
  });

  it('move_doc maps a failed move task to upstream_error (#41)', async () => {
    ctx.token = accessToken;
    mock.failNextMove();
    await expect(
      connector.execute('move_doc', { doc_id: 'w-1', folder_id: 'folder-x' }, ctx),
    ).rejects.toMatchObject({
      code: 'upstream_error',
      retryable: false,
      upstream: { code: 'move_failed' },
    });
  });

  it('rename_doc preserves the root block\'s other elements and styling (#41)', async () => {
    ctx.token = accessToken;
    const output = await connector.execute(
      'rename_doc',
      { doc_id: 'w-2', new_title: 'Renamed' },
      ctx,
    );
    expect(output).toEqual({ doc_id: 'w-2', title: 'Renamed' });

    // The PATCH must carry the FULL elements array with only the first
    // run's text replaced — styling and sibling elements survive.
    const patch = mock.lastBlockPatch as {
      update_text_elements: { elements: Array<{ text_run: { content: string; text_element_style?: unknown } }> };
    };
    expect(patch.update_text_elements.elements).toEqual([
      { text_run: { content: 'Renamed', text_element_style: { bold: true } } },
      { text_run: { content: ' Title' } },
    ]);
  });

  it('maps a locked document to upstream_error with the lock code in diagnostics', async () => {
    mock.lockDoc('w-1');
    ctx.token = accessToken;
    const err = await connector
      .execute('rename_doc', { doc_id: 'w-1', new_title: 'Nope' }, ctx)
      .then(() => undefined, (e: unknown) => e);
    expect(err).toMatchObject({
      code: 'upstream_error',
      retryable: false,
      upstream: { code: '10667', message: 'document locked' },
    });
    mock.unlockDoc('w-1');
  });

  it('maps missing documents on writes to not_found', async () => {
    ctx.token = accessToken;
    const err = await connector
      .execute('append_doc_content', { doc_id: 'w-nope', content: 'x' }, ctx)
      .then(() => undefined, (e: unknown) => e);
    expect(err).toMatchObject({ code: 'not_found' });
  });

  it('maps permission denied on writes to upstream_error', async () => {
    mock.failNextDocs({ code: 91672, msg: 'permission denied' });
    ctx.token = accessToken;
    const err = await connector
      .execute('move_doc', { doc_id: 'w-1', folder_id: 'folder-x' }, ctx)
      .then(() => undefined, (e: unknown) => e);
    expect(err).toMatchObject({ code: 'upstream_error', upstream: { code: '91672' } });
  });
});

/**
 * The full write lifecycle through the executor (Seam A + B): create →
 * append → rename → move, each audited, and disallowed writes rejected.
 */
describe('FeishuConnector write lifecycle through the executor (T8)', () => {
  let server: ServerType;
  let baseUrl: string;
  let mock: MockFeishuServer;
  let accessToken: string;

  beforeAll(async () => {
    mock = new MockFeishuServer({ appId: APP_ID, appSecret: APP_SECRET });
    server = serve({ fetch: mock.app.fetch, port: 0 });
    await new Promise((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const oauth = createFeishuOAuthClient(baseUrl);
    const pair = await oauth.exchangeCode({
      creds: { appId: APP_ID, appSecret: APP_SECRET },
      code: await mock.authorizeCode(REDIRECT_URI, 'st-life'),
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
      actions: [...DOCS_ACTIONS, ...MESSAGING_ACTIONS, ...CONNECTION_ACTIONS],
      connectors: [new FeishuConnector(baseUrl, { exportPollMs: 0 })],
      connections: [{ tenantId: TENANT, connectionId: CONNECTION, connectorId: 'feishu_docs' }],
      allowlists,
      audit,
      tokenProvider: { getValidAccessToken: () => Promise.resolve(accessToken) },
    });
    return { executor, audit };
  }

  it('walks create → append → rename → move with audit rows per write', async () => {
    const { executor, audit } = makeExecutor([
      'create_doc',
      'append_doc_content',
      'rename_doc',
      'move_doc',
      'get_doc_content',
      'get_doc_metadata',
    ]);

    const created = await executor.executeAction(TENANT, CONNECTION, 'create_doc', {
      title: 'Lifecycle',
      content: 'Start.',
    });
    expect(created).toMatchObject({ ok: true });
    const docId = (created as { ok: true; output: { doc_id: string } }).output.doc_id;

    const appended = await executor.executeAction(TENANT, CONNECTION, 'append_doc_content', {
      doc_id: docId,
      content: 'Middle.',
    });
    expect(appended).toMatchObject({ ok: true, output: { content: 'Start.\nMiddle.' } });

    const renamed = await executor.executeAction(TENANT, CONNECTION, 'rename_doc', {
      doc_id: docId,
      new_title: 'Lifecycle V2',
    });
    expect(renamed).toMatchObject({ ok: true, output: { title: 'Lifecycle V2' } });

    const moved = await executor.executeAction(TENANT, CONNECTION, 'move_doc', {
      doc_id: docId,
      folder_id: 'folder-final',
    });
    expect(moved).toMatchObject({ ok: true, output: { folder_id: 'folder-final' } });

    const verified = await executor.executeAction(TENANT, CONNECTION, 'get_doc_metadata', {
      doc_id: docId,
    });
    expect(verified).toMatchObject({
      ok: true,
      output: { doc_id: docId, title: 'Lifecycle V2' },
    });

    const rows = audit.list().map((r) => [r.actionName, r.success, r.errorCode]);
    expect(rows).toEqual([
      ['create_doc', true, null],
      ['append_doc_content', true, null],
      ['rename_doc', true, null],
      ['move_doc', true, null],
      ['get_doc_metadata', true, null],
    ]);
  });

  it('rejects disallowed writes with forbidden and audits them', async () => {
    const { executor, audit } = makeExecutor(['get_doc_content']);
    const denied = await executor.executeAction(TENANT, CONNECTION, 'create_doc', {
      title: 'Nope',
    });
    expect(denied).toMatchObject({ ok: false, error: { code: 'forbidden' } });
    expect(audit.list()[0]).toMatchObject({
      actionName: 'create_doc',
      success: false,
      errorCode: 'forbidden',
    });
  });
});

describe('FeishuConnector advanced actions (T9)', () => {
  let server: ServerType;
  let baseUrl: string;
  let mock: MockFeishuServer;
  let accessToken: string;
  let connector: FeishuConnector;

  beforeAll(async () => {
    mock = new MockFeishuServer({ appId: APP_ID, appSecret: APP_SECRET });
    mock.seedDocs([
      {
        doc_id: 'adv-doc',
        title: 'Advanced',
        content: '# Advanced\n\nExport me.',
        owner_id: 'user-9',
        doc_type: 'docx',
        edited_at: '2026-03-01T10:00:00.000Z',
      },
    ]);
    mock.seedSheet('adv-sheet', 'Budget', 'Data', [
      ['Region', 'Q1', 'Q2'],
      ['APAC', 10, 20],
      ['EMEA', 5, 15],
    ]);
    mock.seedBitable('adv-bit', 'Customers', [
      {
        name: 'Leads',
        records: [
          { record_id: 'rec_lead_1', fields: { name: 'Ada', stage: 'qualified' } },
          { record_id: 'rec_lead_2', fields: { name: 'Grace', stage: 'new' } },
        ],
      },
      { name: 'Archive', records: [] },
    ]);
    mock.seedBitable('adv-pg', 'Pager', [
      {
        name: 'Rows',
        records: [
          { record_id: 'rec_pg_1', fields: { n: 1 } },
          { record_id: 'rec_pg_2', fields: { n: 2 } },
          { record_id: 'rec_pg_3', fields: { n: 3 } },
        ],
      },
    ]);
    server = serve({ fetch: mock.app.fetch, port: 0 });
    await new Promise((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const oauth = createFeishuOAuthClient(baseUrl);
    const pair = await oauth.exchangeCode({
      creds: { appId: APP_ID, appSecret: APP_SECRET },
      code: await mock.authorizeCode(REDIRECT_URI, 'st-adv'),
      redirectUri: REDIRECT_URI,
    });
    accessToken = pair.accessToken;
    connector = new FeishuConnector(baseUrl, { exportPollMs: 0 });
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  const ctx = { tenantId: TENANT, connectionId: CONNECTION, token: '' };

  function withToken(): { tenantId: string; connectionId: string; token: string } {
    return { ...ctx, token: accessToken };
  }

  it('export_doc exports pdf and returns an artifact reference', async () => {
    const result = await connector.execute(
      'export_doc',
      { doc_id: 'adv-doc', format: 'pdf' },
      withToken(),
    );
    expect(result).toMatchObject({
      doc_id: 'adv-doc',
      format: 'pdf',
    });
    const output = result as { artifact_id: string; url: string };
    expect(output.artifact_id).toBeTruthy();
    expect(output.url).toContain('/open-apis/drive/v1/medias/');
  });

  it('export_doc exports the docx format', async () => {
    const result = await connector.execute(
      'export_doc',
      { doc_id: 'adv-doc', format: 'docx' },
      withToken(),
    );
    expect(result).toMatchObject({ doc_id: 'adv-doc', format: 'docx' });
  });

  it('export_doc polls a pending export task until it completes', async () => {
    mock.holdNextExport();
    const result = await connector.execute(
      'export_doc',
      { doc_id: 'adv-doc', format: 'pdf' },
      withToken(),
    );
    expect(result).toMatchObject({ doc_id: 'adv-doc', format: 'pdf' });
  });

  it('export_doc maps a failed export task to upstream_error', async () => {
    mock.failNextExport();
    await expect(
      connector.execute('export_doc', { doc_id: 'adv-doc', format: 'pdf' }, withToken()),
    ).rejects.toMatchObject({
      code: 'upstream_error',
      retryable: false,
    });
  });

  it('export_doc maps a missing document to not_found', async () => {
    await expect(
      connector.execute('export_doc', { doc_id: 'missing', format: 'pdf' }, withToken()),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('get_doc_metadata detects a sheet\'s real type and returns its metadata (#41)', async () => {
    const result = await connector.execute('get_doc_metadata', { doc_id: 'adv-sheet' }, withToken());
    expect(result).toMatchObject({ doc_id: 'adv-sheet', title: 'Budget', doc_type: 'sheet' });
  });

  it('get_doc_metadata detects a bitable\'s real type (#41)', async () => {
    const result = await connector.execute('get_doc_metadata', { doc_id: 'adv-bit' }, withToken());
    expect(result).toMatchObject({ doc_id: 'adv-bit', doc_type: 'bitable' });
  });

  it('move_doc detects the real type and moves a sheet (#41)', async () => {
    const result = await connector.execute(
      'move_doc',
      { doc_id: 'adv-sheet', folder_id: 'folder-2' },
      withToken(),
    );
    expect(result).toEqual({ doc_id: 'adv-sheet', folder_id: 'folder-2' });
  });

  it('export_doc detects the real type and exports a sheet to xlsx (#41)', async () => {
    const result = await connector.execute(
      'export_doc',
      { doc_id: 'adv-sheet', format: 'xlsx' },
      withToken(),
    );
    expect(result).toMatchObject({ doc_id: 'adv-sheet', format: 'xlsx' });
    const output = result as { artifact_id: string };
    expect(output.artifact_id).toBeTruthy();
  });

  it('get_export_artifact downloads an exported artifact as base64 (#43)', async () => {
    const exported = (await connector.execute(
      'export_doc',
      { doc_id: 'adv-doc', format: 'pdf' },
      withToken(),
    )) as { artifact_id: string };

    const result = await connector.execute(
      'get_export_artifact',
      { artifact_id: exported.artifact_id },
      withToken(),
    );

    // The mock's artifact bytes are deterministic ASCII, so the full
    // output — including the base64 encoding — is assertable verbatim.
    const expected = `MOCK-EXPORT-pdf-${exported.artifact_id}`;
    expect(result).toEqual({
      artifact_id: exported.artifact_id,
      content_type: 'application/pdf',
      size_bytes: expected.length,
      content_base64: Buffer.from(expected, 'utf8').toString('base64'),
    });
  });

  it('get_export_artifact maps a missing artifact to not_found (#43)', async () => {
    await expect(
      connector.execute('get_export_artifact', { artifact_id: 'exported_none' }, withToken()),
    ).rejects.toMatchObject({ code: 'not_found', retryable: false });
  });

  it('get_export_artifact rejects an artifact over the 10 MiB cap (#43)', async () => {
    const exported = (await connector.execute(
      'export_doc',
      { doc_id: 'adv-doc', format: 'pdf' },
      withToken(),
    )) as { artifact_id: string };
    mock.setArtifactBytes(
      exported.artifact_id,
      new Uint8Array(10 * 1024 * 1024 + 1),
      'application/pdf',
    );

    await expect(
      connector.execute(
        'get_export_artifact',
        { artifact_id: exported.artifact_id },
        withToken(),
      ),
    ).rejects.toMatchObject({
      code: 'upstream_error',
      retryable: false,
      message:
        'Feishu Docs API artifact exceeds the download cap: 10485761 bytes (cap 10485760)',
    });
  });

  it('feishu_read_bitable_records returns a real next cursor and honors it (#42)', async () => {
    const page1 = (await connector.execute(
      'feishu_read_bitable_records',
      { doc_id: 'adv-pg', table_name: 'Rows', limit: 2 },
      withToken(),
    )) as { data: unknown[]; next: string | null };
    expect(page1.data).toHaveLength(2);
    expect(typeof page1.next).toBe('string');

    const page2 = (await connector.execute(
      'feishu_read_bitable_records',
      { doc_id: 'adv-pg', table_name: 'Rows', limit: 2, page_token: page1.next! },
      withToken(),
    )) as { data: Array<{ record_id: string }>; next: string | null };
    expect(page2.data.map((r) => r.record_id)).toEqual(['rec_pg_3']);
    expect(page2.next).toBeNull();
  });

  it('search_docs returns a real next cursor and honors it (#42)', async () => {
    const page1 = (await connector.execute(
      'search_docs',
      { query: '', limit: 2 },
      withToken(),
    )) as { data: unknown[]; next: string | null };
    expect(page1.data).toHaveLength(2);
    expect(typeof page1.next).toBe('string');

    const page2 = (await connector.execute(
      'search_docs',
      { query: '', limit: 2, page_token: page1.next! },
      withToken(),
    )) as { data: unknown[]; next: string | null };
    expect(page2.data).toHaveLength(2);
    expect(page2.next).toBeNull();
  });

  it('read_sheet_cells resolves the named sheet and preserves cell types', async () => {
    const result = await connector.execute(
      'read_sheet_cells',
      { doc_id: 'adv-sheet', sheet_name: 'Data', range: 'A1:C3' },
      withToken(),
    );
    expect(result).toEqual({
      doc_id: 'adv-sheet',
      range: 'A1:C3',
      data: [
        ['Region', 'Q1', 'Q2'],
        ['APAC', 10, 20],
        ['EMEA', 5, 15],
      ],
      next: null,
    });
  });

  it('write_sheet_cells writes a range and reports updated cells', async () => {
    const result = await connector.execute(
      'write_sheet_cells',
      { doc_id: 'adv-sheet', sheet_name: 'Data', range: 'C3', values: [[30]] },
      withToken(),
    );
    expect(result).toMatchObject({ doc_id: 'adv-sheet', range: 'C3', updated_cells: 1 });

    const read = await connector.execute(
      'read_sheet_cells',
      { doc_id: 'adv-sheet', sheet_name: 'Data', range: 'C3' },
      withToken(),
    );
    expect(read).toMatchObject({ data: [[30]], next: null });
  });

  it('maps a range/shape mismatch on sheet writes to upstream_error', async () => {
    await expect(
      connector.execute(
        'write_sheet_cells',
        { doc_id: 'adv-sheet', sheet_name: 'Data', range: 'A1:B2', values: [[1]] },
        withToken(),
      ),
    ).rejects.toMatchObject({ code: 'upstream_error' });
  });

  it('maps a missing spreadsheet or sheet name to not_found', async () => {
    await expect(
      connector.execute('read_sheet_cells', { doc_id: 'missing', range: 'A1' }, withToken()),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      connector.execute(
        'read_sheet_cells',
        { doc_id: 'adv-sheet', sheet_name: 'Nope', range: 'A1' },
        withToken(),
      ),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('feishu_read_bitable_records returns field-name-based values', async () => {
    const result = await connector.execute(
      'feishu_read_bitable_records',
      { doc_id: 'adv-bit', table_name: 'Leads' },
      withToken(),
    );
    expect(result).toMatchObject({
      doc_id: 'adv-bit',
      table_name: 'Leads',
      data: [
        { record_id: 'rec_lead_1', fields: { name: 'Ada', stage: 'qualified' } },
        { record_id: 'rec_lead_2', fields: { name: 'Grace', stage: 'new' } },
      ],
      next: null,
    });
  });

  it('feishu_read_bitable_records respects the limit', async () => {
    const result = await connector.execute(
      'feishu_read_bitable_records',
      { doc_id: 'adv-bit', table_name: 'Leads', limit: 1 },
      withToken(),
    );
    const items = (result as { data: unknown[] }).data;
    expect(items).toHaveLength(1);
  });

  it('feishu_update_bitable_records updates one record and returns the updated fields (#42)', async () => {
    const result = await connector.execute(
      'feishu_update_bitable_records',
      { doc_id: 'adv-bit', table_name: 'Leads', record_id: 'rec_lead_1', fields: { stage: 'won' } },
      withToken(),
    );
    expect(result).toEqual({
      doc_id: 'adv-bit',
      table_name: 'Leads',
      record_id: 'rec_lead_1',
      fields: { name: 'Ada', stage: 'won' },
    });

    const read = await connector.execute(
      'feishu_read_bitable_records',
      { doc_id: 'adv-bit', table_name: 'Leads', limit: 1 },
      withToken(),
    );
    expect(read).toMatchObject({ data: [{ record_id: 'rec_lead_1', fields: { name: 'Ada', stage: 'won' } }] });
  });

  it('feishu_update_bitable_records maps a missing record to not_found (#42)', async () => {
    await expect(
      connector.execute(
        'feishu_update_bitable_records',
        { doc_id: 'adv-bit', table_name: 'Leads', record_id: 'rec_nope', fields: { stage: 'x' } },
        withToken(),
      ),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('feishu_write_bitable_records creates a record and returns its id', async () => {
    const result = await connector.execute(
      'feishu_write_bitable_records',
      { doc_id: 'adv-bit', table_name: 'Leads', fields: { name: 'Katherine', stage: 'new' } },
      withToken(),
    );
    expect(result).toMatchObject({ doc_id: 'adv-bit', table_name: 'Leads' });
    const recordId = (result as { record_id: string }).record_id;
    expect(recordId).toBeTruthy();

    const read = await connector.execute(
      'feishu_read_bitable_records',
      { doc_id: 'adv-bit', table_name: 'Leads' },
      withToken(),
    );
    const items = (read as { data: Array<{ record_id: string }> }).data;
    expect(items.map((r) => r.record_id)).toContain(recordId);
  });

  it('maps a missing bitable table to not_found', async () => {
    await expect(
      connector.execute('feishu_read_bitable_records', { doc_id: 'adv-bit', table_name: 'Nope' }, withToken()),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('maps permission denial on advanced endpoints to upstream_error with the original code', async () => {
    mock.failNextDocs({ code: 91672, msg: 'no permission' });
    await expect(
      connector.execute(
        'read_sheet_cells',
        { doc_id: 'adv-sheet', sheet_name: 'Data', range: 'A1' },
        withToken(),
      ),
    ).rejects.toMatchObject({
      code: 'upstream_error',
      retryable: false,
      upstream: { code: '91672' },
    });
  });
});

describe('FeishuConnector advanced lifecycle through the executor (T9)', () => {
  let server: ServerType;
  let baseUrl: string;
  let mock: MockFeishuServer;
  let accessToken: string;

  beforeAll(async () => {
    mock = new MockFeishuServer({ appId: APP_ID, appSecret: APP_SECRET });
    mock.seedDocs([
      {
        doc_id: 'life-doc',
        title: 'Lifecycle',
        content: 'Start.',
        owner_id: 'user-9',
        doc_type: 'docx',
        edited_at: '2026-03-01T10:00:00.000Z',
      },
    ]);
    mock.seedSheet('life-sheet', 'Tracker', 'Data', [
      ['Region', 'Q1'],
      ['APAC', 10],
    ]);
    mock.seedBitable('life-bit', 'Customers', [
      { name: 'Leads', records: [{ record_id: 'rec_life_1', fields: { name: 'Ada' } }] },
    ]);
    server = serve({ fetch: mock.app.fetch, port: 0 });
    await new Promise((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const oauth = createFeishuOAuthClient(baseUrl);
    const pair = await oauth.exchangeCode({
      creds: { appId: APP_ID, appSecret: APP_SECRET },
      code: await mock.authorizeCode(REDIRECT_URI, 'st-life9'),
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
      actions: [...DOCS_ACTIONS, ...MESSAGING_ACTIONS, ...CONNECTION_ACTIONS],
      connectors: [new FeishuConnector(baseUrl, { exportPollMs: 0 })],
      connections: [{ tenantId: TENANT, connectionId: CONNECTION, connectorId: 'feishu_docs' }],
      allowlists,
      audit,
      tokenProvider: { getValidAccessToken: () => Promise.resolve(accessToken) },
    });
    return { executor, audit };
  }

  it('walks export → artifact download → sheet write/read → bitable write/read with audit rows', async () => {
    const { executor, audit } = makeExecutor([
      'export_doc',
      'get_export_artifact',
      'read_sheet_cells',
      'write_sheet_cells',
      'feishu_read_bitable_records',
      'feishu_write_bitable_records',
    ]);

    const exported = await executor.executeAction(TENANT, CONNECTION, 'export_doc', {
      doc_id: 'life-doc',
      format: 'pdf',
    });
    expect(exported).toMatchObject({ ok: true, output: { doc_id: 'life-doc', format: 'pdf' } });

    // #43: the export loop closes at Seam A — the boundary validates the
    // canonical output schema (base64 + content type + size) like any
    // other action, and the download is audited.
    const artifactId = (exported as { ok: true; output: { artifact_id: string } }).output
      .artifact_id;
    const downloaded = await executor.executeAction(TENANT, CONNECTION, 'get_export_artifact', {
      artifact_id: artifactId,
    });
    expect(downloaded).toMatchObject({
      ok: true,
      output: {
        artifact_id: artifactId,
        content_type: 'application/pdf',
        size_bytes: `MOCK-EXPORT-pdf-${artifactId}`.length,
        content_base64: Buffer.from(`MOCK-EXPORT-pdf-${artifactId}`, 'utf8').toString('base64'),
      },
    });

    const sheetWrite = await executor.executeAction(TENANT, CONNECTION, 'write_sheet_cells', {
      doc_id: 'life-sheet',
      sheet_name: 'Data',
      range: 'B2',
      values: [[42]],
    });
    expect(sheetWrite).toMatchObject({ ok: true, output: { updated_cells: 1 } });

    const sheetRead = await executor.executeAction(TENANT, CONNECTION, 'read_sheet_cells', {
      doc_id: 'life-sheet',
      sheet_name: 'Data',
      range: 'A1:B2',
    });
    expect(sheetRead).toMatchObject({
      ok: true,
      output: {
        data: [
          ['Region', 'Q1'],
          ['APAC', 42],
        ],
        next: null,
      },
    });

    const bitableWrite = await executor.executeAction(
      TENANT,
      CONNECTION,
      'feishu_write_bitable_records',
      { doc_id: 'life-bit', table_name: 'Leads', fields: { name: 'Grace' } },
    );
    expect(bitableWrite).toMatchObject({ ok: true });
    const recordId = (bitableWrite as { ok: true; output: { record_id: string } }).output
      .record_id;

    const bitableRead = await executor.executeAction(TENANT, CONNECTION, 'feishu_read_bitable_records', {
      doc_id: 'life-bit',
      table_name: 'Leads',
    });
    expect(bitableRead).toMatchObject({
      ok: true,
      output: {
        data: [
          { record_id: 'rec_life_1', fields: { name: 'Ada' } },
          { record_id: recordId, fields: { name: 'Grace' } },
        ],
        next: null,
      },
    });

    const rows = audit.list().map((r) => [r.actionName, r.success, r.errorCode]);
    expect(rows).toEqual([
      ['export_doc', true, null],
      ['get_export_artifact', true, null],
      ['write_sheet_cells', true, null],
      ['read_sheet_cells', true, null],
      ['feishu_write_bitable_records', true, null],
      ['feishu_read_bitable_records', true, null],
    ]);
  });

  it('rejects disallowed advanced actions with forbidden and audits them', async () => {
    const { executor, audit } = makeExecutor(['read_sheet_cells']);
    const denied = await executor.executeAction(TENANT, CONNECTION, 'export_doc', {
      doc_id: 'life-doc',
      format: 'pdf',
    });
    expect(denied).toMatchObject({ ok: false, error: { code: 'forbidden' } });
    expect(audit.list().map((r) => [r.actionName, r.success, r.errorCode])).toEqual([
      ['export_doc', false, 'forbidden'],
    ]);
  });
});

describe('FakeConnector advanced actions through the executor (Seam A)', () => {
  it('round-trips export, sheet and bitable actions with audit rows', async () => {
    const fake = new FakeConnector([
      { doc_id: 'f-doc', title: 'Doc', content: 'x' },
      {
        doc_id: 'f-sheet',
        title: 'Sheet',
        content: '',
        sheet: {
          sheetId: 'sht-f-sheet',
          sheetName: 'Data',
          values: [
            [1, 'a'],
            [2, 'b'],
          ],
        },
      },
      {
        doc_id: 'f-bit',
        title: 'Bitable',
        content: '',
        bitable: new Map([
          ['Leads', [{ record_id: 'rec_1', fields: { name: 'Ada', active: true } }]],
        ]),
      },
    ]);
    const { executor, audit } = makeHarness({ connectors: [fake] });

    const exported = await executor.executeAction(TENANT_A, CONN_1, 'export_doc', {
      doc_id: 'f-doc',
      format: 'pdf',
    });
    expect(exported).toMatchObject({
      ok: true,
      output: { doc_id: 'f-doc', format: 'pdf' },
    });
    expect((exported as { ok: true; output: { artifact_id: string } }).output.artifact_id).toBeTruthy();

    // #43: the fake closes the export loop too — download through the
    // boundary, output validated against the canonical schema.
    const artifactId = (exported as { ok: true; output: { artifact_id: string } }).output
      .artifact_id;
    const downloaded = await executor.executeAction(TENANT_A, CONN_1, 'get_export_artifact', {
      artifact_id: artifactId,
    });
    expect(downloaded).toMatchObject({
      ok: true,
      output: {
        artifact_id: artifactId,
        content_type: 'application/pdf',
        size_bytes: `FAKE-EXPORT-${artifactId}`.length,
        content_base64: Buffer.from(`FAKE-EXPORT-${artifactId}`, 'utf8').toString('base64'),
      },
    });

    const read = await executor.executeAction(TENANT_A, CONN_1, 'read_sheet_cells', {
      doc_id: 'f-sheet',
      range: 'A1:B2',
    });
    expect(read).toMatchObject({
      ok: true,
      output: {
        data: [
          [1, 'a'],
          [2, 'b'],
        ],
        next: null,
      },
    });

    const written = await executor.executeAction(TENANT_A, CONN_1, 'write_sheet_cells', {
      doc_id: 'f-sheet',
      sheet_name: 'Data',
      range: 'A1:B2',
      values: [
        ['x', 'y'],
        ['z', 'w'],
      ],
    });
    expect(written).toMatchObject({ ok: true, output: { updated_cells: 4 } });

    const reread = await executor.executeAction(TENANT_A, CONN_1, 'read_sheet_cells', {
      doc_id: 'f-sheet',
      range: 'A1:B2',
    });
    expect(reread).toMatchObject({
      ok: true,
      output: {
        data: [
          ['x', 'y'],
          ['z', 'w'],
        ],
        next: null,
      },
    });

    const records = await executor.executeAction(TENANT_A, CONN_1, 'feishu_read_bitable_records', {
      doc_id: 'f-bit',
      table_name: 'Leads',
    });
    expect(records).toMatchObject({
      ok: true,
      output: { data: [{ record_id: 'rec_1', fields: { name: 'Ada', active: true } }], next: null },
    });

    const created = await executor.executeAction(TENANT_A, CONN_1, 'feishu_write_bitable_records', {
      doc_id: 'f-bit',
      table_name: 'Leads',
      fields: { name: 'Grace', active: false },
    });
    expect(created).toMatchObject({ ok: true });
    const recordId = (created as { ok: true; output: { record_id: string } }).output.record_id;
    expect(recordId).toBeTruthy();

    const after = await executor.executeAction(TENANT_A, CONN_1, 'feishu_read_bitable_records', {
      doc_id: 'f-bit',
      table_name: 'Leads',
    });
    expect(after).toMatchObject({
      ok: true,
      output: { data: [{ record_id: 'rec_1' }, { record_id: recordId }], next: null },
    });

    const rows = audit.list().map((r) => [r.actionName, r.success, r.errorCode]);
    expect(rows).toEqual([
      ['export_doc', true, null],
      ['get_export_artifact', true, null],
      ['read_sheet_cells', true, null],
      ['write_sheet_cells', true, null],
      ['read_sheet_cells', true, null],
      ['feishu_read_bitable_records', true, null],
      ['feishu_write_bitable_records', true, null],
      ['feishu_read_bitable_records', true, null],
    ]);
  });

  it('feishu_update_bitable_records updates through the executor with governance (#42)', async () => {
    const fake = new FakeConnector([
      {
        doc_id: 'f-bit2',
        title: 'Bit',
        content: '',
        bitable: new Map([
          ['Leads', [{ record_id: 'rec_9', fields: { name: 'Ada', stage: 'new' } }]],
        ]),
      },
    ]);
    const { executor, audit } = makeHarness({ connectors: [fake] });

    const updated = await executor.executeAction(TENANT_A, CONN_1, 'feishu_update_bitable_records', {
      doc_id: 'f-bit2',
      table_name: 'Leads',
      record_id: 'rec_9',
      fields: { stage: 'won' },
    });
    expect(updated).toMatchObject({
      ok: true,
      output: { record_id: 'rec_9', fields: { name: 'Ada', stage: 'won' } },
    });

    const missing = await executor.executeAction(TENANT_A, CONN_1, 'feishu_update_bitable_records', {
      doc_id: 'f-bit2',
      table_name: 'Leads',
      record_id: 'nope',
      fields: {},
    });
    expect(missing).toMatchObject({ ok: false, error: { code: 'not_found' } });

    expect(audit.list().map((r) => [r.actionName, r.success, r.errorCode])).toEqual([
      ['feishu_update_bitable_records', true, null],
      ['feishu_update_bitable_records', false, 'not_found'],
    ]);
  });

  it('maps missing resources to not_found', async () => {
    const fake = new FakeConnector([
      { doc_id: 'f-doc', title: 'Doc', content: 'x' },
      { doc_id: 'f-sheet', title: 'Sheet', content: '', sheet: { sheetId: 'sht-f-sheet', sheetName: 'Data', values: [['a']] } },
    ]);
    const { executor } = makeHarness({ connectors: [fake] });

    const missingDoc = await executor.executeAction(TENANT_A, CONN_1, 'export_doc', {
      doc_id: 'nope',
      format: 'pdf',
    });
    expect(missingDoc).toMatchObject({ ok: false, error: { code: 'not_found' } });

    const missingSheet = await executor.executeAction(TENANT_A, CONN_1, 'read_sheet_cells', {
      doc_id: 'f-doc',
      range: 'Data!A1',
    });
    expect(missingSheet).toMatchObject({ ok: false, error: { code: 'not_found' } });

    const unknownSheetName = await executor.executeAction(TENANT_A, CONN_1, 'read_sheet_cells', {
      doc_id: 'f-sheet',
      sheet_name: 'Nope',
      range: 'A1',
    });
    expect(unknownSheetName).toMatchObject({ ok: false, error: { code: 'not_found' } });

    const missingTable = await executor.executeAction(TENANT_A, CONN_1, 'feishu_read_bitable_records', {
      doc_id: 'f-sheet',
      table_name: 'Nope',
    });
    expect(missingTable).toMatchObject({ ok: false, error: { code: 'not_found' } });
  });
});

describe('mapFeishuError (error translation)', () => {
  it('maps both token-rejection codes to auth_expired', () => {
    for (const code of [99991668, 99991672]) {
      const err = mapFeishuError(new FeishuApiError(code, 'invalid access token', 200, false));
      expect(err).toMatchObject({ code: 'auth_expired', retryable: false });
    }
  });

  it('maps rate-limit codes to rate_limited', () => {
    const err = mapFeishuError(new FeishuApiError(99991400, 'too many requests', 200, false));
    expect(err).toMatchObject({ code: 'rate_limited', retryable: true });
  });
});

/**
 * The destructive family (ADR-0018): delete_doc (canonical, drive delete
 * task) and feishu_delete_bitable_records (provider-native, batch delete).
 * Same translator rules as every action — the destructive class is a
 * governance contract at Seam A, not connector behavior.
 */
describe('FeishuConnector destructive actions (#44)', () => {
  let server: ServerType;
  let baseUrl: string;
  let mock: MockFeishuServer;
  let accessToken: string;
  let connector: FeishuConnector;

  beforeAll(async () => {
    mock = new MockFeishuServer({ appId: APP_ID, appSecret: APP_SECRET });
    mock.seedDocs([
      {
        doc_id: 'd-doc',
        title: 'Doomed Doc',
        content: 'Delete me.',
        owner_id: 'user-9',
        doc_type: 'docx',
        edited_at: '2026-03-01T10:00:00.000Z',
      },
      {
        doc_id: 'd-sheet',
        title: 'Doomed Sheet',
        content: '',
        owner_id: 'user-9',
        doc_type: 'sheet',
        edited_at: '2026-03-01T10:00:00.000Z',
      },
    ]);
    mock.seedBitable('d-bit', 'Records', [
      {
        name: 'Leads',
        records: [
          { record_id: 'rec_d_1', fields: { name: 'Ada' } },
          { record_id: 'rec_d_2', fields: { name: 'Grace' } },
          { record_id: 'rec_d_3', fields: { name: 'Lin' } },
        ],
      },
    ]);
    server = serve({ fetch: mock.app.fetch, port: 0 });
    await new Promise((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const oauth = createFeishuOAuthClient(baseUrl);
    const pair = await oauth.exchangeCode({
      creds: { appId: APP_ID, appSecret: APP_SECRET },
      code: await mock.authorizeCode(REDIRECT_URI, 'st-destr'),
      redirectUri: REDIRECT_URI,
    });
    accessToken = pair.accessToken;
    connector = new FeishuConnector(baseUrl, { exportPollMs: 0, movePollMs: 0 });
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  const ctx = { tenantId: TENANT, connectionId: CONNECTION, token: '' };

  function withToken(): { tenantId: string; connectionId: string; token: string } {
    return { ...ctx, token: accessToken };
  }

  it('delete_doc deletes a docx and returns its id', async () => {
    const output = await connector.execute('delete_doc', { doc_id: 'd-doc' }, withToken());
    expect(output).toEqual({ doc_id: 'd-doc' });

    // Gone from the connector's world: the follow-up read is not_found.
    await expect(
      connector.execute('get_doc_content', { doc_id: 'd-doc' }, withToken()),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('delete_doc detects the real type and deletes a sheet (#41 probe reused)', async () => {
    const output = await connector.execute('delete_doc', { doc_id: 'd-sheet' }, withToken());
    expect(output).toEqual({ doc_id: 'd-sheet' });
  });

  it('delete_doc polls a pending delete task until it completes', async () => {
    // A fresh doc: seed through the connector itself.
    const created = (await connector.execute(
      'create_doc',
      { title: 'Held Delete' },
      withToken(),
    )) as { doc_id: string };
    mock.holdNextDelete();
    const output = await connector.execute('delete_doc', { doc_id: created.doc_id }, withToken());
    expect(output).toEqual({ doc_id: created.doc_id });
  });

  it('delete_doc maps a failed delete task to upstream_error', async () => {
    const created = (await connector.execute(
      'create_doc',
      { title: 'Failed Delete' },
      withToken(),
    )) as { doc_id: string };
    mock.failNextDelete();
    await expect(
      connector.execute('delete_doc', { doc_id: created.doc_id }, withToken()),
    ).rejects.toMatchObject({
      code: 'upstream_error',
      retryable: false,
      upstream: { code: 'delete_failed' },
    });
  });

  it('delete_doc maps an unknown doc to not_found', async () => {
    await expect(
      connector.execute('delete_doc', { doc_id: 'no-such' }, withToken()),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('feishu_delete_bitable_records deletes a batch and reports the count', async () => {
    const output = await connector.execute(
      'feishu_delete_bitable_records',
      { doc_id: 'd-bit', table_name: 'Leads', record_ids: ['rec_d_1', 'rec_d_2'] },
      withToken(),
    );
    expect(output).toEqual({
      doc_id: 'd-bit',
      table_name: 'Leads',
      deleted_count: 2,
    });

    // The remaining record is still readable.
    const page = (await connector.execute(
      'feishu_read_bitable_records',
      { doc_id: 'd-bit', table_name: 'Leads' },
      withToken(),
    )) as { data: Array<{ record_id: string }> };
    expect(page.data.map((r) => r.record_id)).toEqual(['rec_d_3']);
  });

  it('feishu_delete_bitable_records maps a missing record to not_found', async () => {
    await expect(
      connector.execute(
        'feishu_delete_bitable_records',
        { doc_id: 'd-bit', table_name: 'Leads', record_ids: ['rec_d_3', 'ghost'] },
        withToken(),
      ),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('feishu_delete_bitable_records maps an unknown table to not_found', async () => {
    await expect(
      connector.execute(
        'feishu_delete_bitable_records',
        { doc_id: 'd-bit', table_name: 'Nope', record_ids: ['rec_d_3'] },
        withToken(),
      ),
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});
