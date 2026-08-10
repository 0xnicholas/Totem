import { serve, type ServerType } from '@hono/node-server';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFeishuOAuthClient } from '../src/feishu/oauth.js';
import { FeishuConnector } from '../src/feishu/connector.js';
import { CONNECTION_ACTIONS, DOCS_ACTIONS, createActionExecutor } from '../src/index.js';
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
      actions: [...DOCS_ACTIONS, ...CONNECTION_ACTIONS],
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
    connector = new FeishuConnector(baseUrl, { exportPollMs: 0 });
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
      actions: [...DOCS_ACTIONS, ...CONNECTION_ACTIONS],
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

  it('read_sheet_cells resolves the named sheet and preserves cell types', async () => {
    const result = await connector.execute(
      'read_sheet_cells',
      { doc_id: 'adv-sheet', sheet_name: 'Data', range: 'A1:C3' },
      withToken(),
    );
    expect(result).toEqual({
      doc_id: 'adv-sheet',
      range: 'A1:C3',
      values: [
        ['Region', 'Q1', 'Q2'],
        ['APAC', 10, 20],
        ['EMEA', 5, 15],
      ],
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
    expect(read).toMatchObject({ values: [[30]] });
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

  it('read_bitable_records returns field-name-based values', async () => {
    const result = await connector.execute(
      'read_bitable_records',
      { doc_id: 'adv-bit', table_name: 'Leads' },
      withToken(),
    );
    expect(result).toMatchObject({
      doc_id: 'adv-bit',
      table_name: 'Leads',
      records: [
        { record_id: 'rec_lead_1', fields: { name: 'Ada', stage: 'qualified' } },
        { record_id: 'rec_lead_2', fields: { name: 'Grace', stage: 'new' } },
      ],
    });
  });

  it('read_bitable_records respects the limit', async () => {
    const result = await connector.execute(
      'read_bitable_records',
      { doc_id: 'adv-bit', table_name: 'Leads', limit: 1 },
      withToken(),
    );
    const records = (result as { records: unknown[] }).records;
    expect(records).toHaveLength(1);
  });

  it('write_bitable_records creates a record and returns its id', async () => {
    const result = await connector.execute(
      'write_bitable_records',
      { doc_id: 'adv-bit', table_name: 'Leads', fields: { name: 'Katherine', stage: 'new' } },
      withToken(),
    );
    expect(result).toMatchObject({ doc_id: 'adv-bit', table_name: 'Leads' });
    const recordId = (result as { record_id: string }).record_id;
    expect(recordId).toBeTruthy();

    const read = await connector.execute(
      'read_bitable_records',
      { doc_id: 'adv-bit', table_name: 'Leads' },
      withToken(),
    );
    const records = (read as { records: Array<{ record_id: string }> }).records;
    expect(records.map((r) => r.record_id)).toContain(recordId);
  });

  it('maps a missing bitable table to not_found', async () => {
    await expect(
      connector.execute('read_bitable_records', { doc_id: 'adv-bit', table_name: 'Nope' }, withToken()),
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
      actions: [...DOCS_ACTIONS, ...CONNECTION_ACTIONS],
      connectors: [new FeishuConnector(baseUrl, { exportPollMs: 0 })],
      connections: [{ tenantId: TENANT, connectionId: CONNECTION, connectorId: 'feishu_docs' }],
      allowlists,
      audit,
      tokenProvider: { getValidAccessToken: () => Promise.resolve(accessToken) },
    });
    return { executor, audit };
  }

  it('walks export → sheet write/read → bitable write/read with audit rows', async () => {
    const { executor, audit } = makeExecutor([
      'export_doc',
      'read_sheet_cells',
      'write_sheet_cells',
      'read_bitable_records',
      'write_bitable_records',
    ]);

    const exported = await executor.executeAction(TENANT, CONNECTION, 'export_doc', {
      doc_id: 'life-doc',
      format: 'pdf',
    });
    expect(exported).toMatchObject({ ok: true, output: { doc_id: 'life-doc', format: 'pdf' } });

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
        values: [
          ['Region', 'Q1'],
          ['APAC', 42],
        ],
      },
    });

    const bitableWrite = await executor.executeAction(
      TENANT,
      CONNECTION,
      'write_bitable_records',
      { doc_id: 'life-bit', table_name: 'Leads', fields: { name: 'Grace' } },
    );
    expect(bitableWrite).toMatchObject({ ok: true });
    const recordId = (bitableWrite as { ok: true; output: { record_id: string } }).output
      .record_id;

    const bitableRead = await executor.executeAction(TENANT, CONNECTION, 'read_bitable_records', {
      doc_id: 'life-bit',
      table_name: 'Leads',
    });
    expect(bitableRead).toMatchObject({
      ok: true,
      output: { records: [{ record_id: 'rec_life_1', fields: { name: 'Ada' } }, { record_id: recordId, fields: { name: 'Grace' } }] },
    });

    const rows = audit.list().map((r) => [r.actionName, r.success, r.errorCode]);
    expect(rows).toEqual([
      ['export_doc', true, null],
      ['write_sheet_cells', true, null],
      ['read_sheet_cells', true, null],
      ['write_bitable_records', true, null],
      ['read_bitable_records', true, null],
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

    const read = await executor.executeAction(TENANT_A, CONN_1, 'read_sheet_cells', {
      doc_id: 'f-sheet',
      range: 'A1:B2',
    });
    expect(read).toMatchObject({
      ok: true,
      output: {
        values: [
          [1, 'a'],
          [2, 'b'],
        ],
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
        values: [
          ['x', 'y'],
          ['z', 'w'],
        ],
      },
    });

    const records = await executor.executeAction(TENANT_A, CONN_1, 'read_bitable_records', {
      doc_id: 'f-bit',
      table_name: 'Leads',
    });
    expect(records).toMatchObject({
      ok: true,
      output: { records: [{ record_id: 'rec_1', fields: { name: 'Ada', active: true } }] },
    });

    const created = await executor.executeAction(TENANT_A, CONN_1, 'write_bitable_records', {
      doc_id: 'f-bit',
      table_name: 'Leads',
      fields: { name: 'Grace', active: false },
    });
    expect(created).toMatchObject({ ok: true });
    const recordId = (created as { ok: true; output: { record_id: string } }).output.record_id;
    expect(recordId).toBeTruthy();

    const after = await executor.executeAction(TENANT_A, CONN_1, 'read_bitable_records', {
      doc_id: 'f-bit',
      table_name: 'Leads',
    });
    expect(after).toMatchObject({
      ok: true,
      output: { records: [{ record_id: 'rec_1' }, { record_id: recordId }] },
    });

    const rows = audit.list().map((r) => [r.actionName, r.success, r.errorCode]);
    expect(rows).toEqual([
      ['export_doc', true, null],
      ['read_sheet_cells', true, null],
      ['write_sheet_cells', true, null],
      ['read_sheet_cells', true, null],
      ['read_bitable_records', true, null],
      ['write_bitable_records', true, null],
      ['read_bitable_records', true, null],
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

    const missingTable = await executor.executeAction(TENANT_A, CONN_1, 'read_bitable_records', {
      doc_id: 'f-sheet',
      table_name: 'Nope',
    });
    expect(missingTable).toMatchObject({ ok: false, error: { code: 'not_found' } });
  });
});
