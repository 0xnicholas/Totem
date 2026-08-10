import { serve, type ServerType } from '@hono/node-server';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { McpAdapter } from '../src/mcp/adapter.js';
import { createMcpApp } from '../src/mcp/server.js';
import { FakeConnector, type FakeDoc } from '../src/testing/fake-connector.js';
import { InMemoryMCPKeyStore } from '../src/testing/memory-key-store.js';
import { CONN_1, TENANT_A, makeHarness } from './fixtures.js';

const ACTION_KEY = 'tt_dev_mcp_test_key';

/** Harness wiring for the MCP HTTP surface: executor + stores + keys. */
function makeServer(initialDocs?: FakeDoc[]) {
  const harness = makeHarness({
    connectors: [new FakeConnector(initialDocs)],
  });
  const keys = new InMemoryMCPKeyStore();
  keys.addKey(ACTION_KEY, TENANT_A);
  const adapter = new McpAdapter(harness.executor, harness.allowlists);
  const app = createMcpApp({ adapter, keys });
  return { ...harness, keys, app };
}

/** POSTs a raw JSON-RPC message and returns the parsed payload (SSE or JSON). */
async function rpc(
  app: ReturnType<typeof makeServer>['app'],
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; sessionId: string | null; payload: unknown }> {
  const res = await app.fetch(
    new Request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...headers,
      },
      body: JSON.stringify(body),
    }),
  );
  const text = await res.text();
  let payload: unknown;
  if ((res.headers.get('content-type') ?? '').includes('text/event-stream')) {
    const dataLines = text
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice('data:'.length).trim());
    payload = JSON.parse(dataLines[dataLines.length - 1] ?? '{}');
  } else {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }
  return { status: res.status, sessionId: res.headers.get('mcp-session-id'), payload };
}

function rpcResult(payload: { result?: unknown; error?: { code: number; message: string } }): {
  result?: unknown;
  error?: { code: number; message: string };
} {
  return { result: payload.result, error: payload.error };
}

describe('MCP HTTP surface: auth and connection resolution', () => {
  it('rejects requests without an Authorization header with 401', async () => {
    const { app } = makeServer();
    const res = await rpc(app, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    expect(res.status).toBe(401);
  });

  it('rejects unknown keys with 401', async () => {
    const { app } = makeServer();
    const res = await rpc(app, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, {
      authorization: 'Bearer tt_dev_wrong_key',
    });
    expect(res.status).toBe(401);
  });

  it('rejects admin-scoped keys with 401 (actions scope only)', async () => {
    const { app, keys } = makeServer();
    keys.addKey('tt_dev_admin_scoped', TENANT_A, { scope: 'admin' });
    const res = await rpc(app, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, {
      authorization: 'Bearer tt_dev_admin_scoped',
    });
    expect(res.status).toBe(401);
  });

  it('rejects disabled keys with 401', async () => {
    const { app, keys } = makeServer();
    keys.addKey('tt_dev_disabled_key', TENANT_A, { disabled: true });
    const res = await rpc(app, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, {
      authorization: 'Bearer tt_dev_disabled_key',
    });
    expect(res.status).toBe(401);
  });

  it('rejects a missing x-connection-id with 400', async () => {
    const { app } = makeServer();
    const res = await rpc(app, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, {
      authorization: `Bearer ${ACTION_KEY}`,
    });
    expect(res.status).toBe(400);
  });

  it('rejects an unknown connection for the tenant with 400', async () => {
    const { app } = makeServer();
    const res = await rpc(
      app,
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      { authorization: `Bearer ${ACTION_KEY}`, 'x-connection-id': 'conn-unknown' },
    );
    expect(res.status).toBe(400);
  });

  it('accepts x-connection-id as a query-param fallback', async () => {
    const { app } = makeServer();
    const res = await app.fetch(
      new Request(`http://localhost/mcp?x-connection-id=${CONN_1}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${ACTION_KEY}`,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '0' } },
        }),
      }),
    );
    expect(res.status).toBe(200);
  });
});

describe('MCP HTTP surface: session and tool lifecycle', () => {
  it('walks initialize → tools/list → tools/call in one session', async () => {
    const { app } = makeServer();
    const authHeaders = { authorization: `Bearer ${ACTION_KEY}`, 'x-connection-id': CONN_1 };

    const init = await rpc(app, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '0' } },
    }, authHeaders);
    expect(init.status).toBe(200);
    expect(init.sessionId).toBeTruthy();
    expect(init.payload).toMatchObject({ result: { capabilities: { tools: {} } } });

    const sessionHeaders = { ...authHeaders, 'mcp-session-id': init.sessionId! };
    const listed = await rpc(app, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, sessionHeaders);
    expect(listed.status).toBe(200);
    expect(rpcResult(listed.payload as never)).toMatchObject({
      result: {
        tools: [
          { name: 'create_doc' },
          { name: 'search_docs' },
          { name: 'get_doc_content' },
          { name: 'get_doc_metadata' },
          { name: 'append_doc_content' },
          { name: 'rename_doc' },
          { name: 'move_doc' },
          { name: 'export_doc' },
          { name: 'read_sheet_cells' },
          { name: 'write_sheet_cells' },
          { name: 'read_bitable_records' },
          { name: 'write_bitable_records' },
          { name: 'test_connection' },
        ],
      },
    });

    const called = await rpc(
      app,
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'create_doc', arguments: { title: 'raw rpc' } } },
      sessionHeaders,
    );
    const result = rpcResult(called.payload as never).result as { content: [{ text: string }]; structuredContent?: unknown };
    expect(result.content[0].text).toContain('raw rpc');
    expect(result.structuredContent).toMatchObject({ title: 'raw rpc' });
  });

  it('hides allowlisted-out tools from tools/list (ADR-0002)', async () => {
    const server = makeServer();
    server.allowlists.setAllowed(TENANT_A, CONN_1, ['create_doc']);
    const init = await rpc(server.app, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '0' } },
    }, { authorization: `Bearer ${ACTION_KEY}`, 'x-connection-id': CONN_1 });
    const listed = await rpc(
      server.app,
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
      { authorization: `Bearer ${ACTION_KEY}`, 'x-connection-id': CONN_1, 'mcp-session-id': init.sessionId! },
    );
    expect(rpcResult(listed.payload as never)).toMatchObject({
      result: { tools: [{ name: 'create_doc' }] },
    });
  });

  it('maps calls to hidden tools to JSON-RPC invalid params (-32602)', async () => {
    const server = makeServer();
    server.allowlists.setAllowed(TENANT_A, CONN_1, ['create_doc']);
    const init = await rpc(server.app, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '0' } },
    }, { authorization: `Bearer ${ACTION_KEY}`, 'x-connection-id': CONN_1 });
    const called = await rpc(
      server.app,
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'get_doc_content', arguments: { doc_id: 'x' } },
      },
      { authorization: `Bearer ${ACTION_KEY}`, 'x-connection-id': CONN_1, 'mcp-session-id': init.sessionId! },
    );
    expect(rpcResult(called.payload as never)).toMatchObject({ error: { code: -32602 } });
  });

  it('surfaces validation failures as isError results with the unified vocabulary', async () => {
    const { app } = makeServer();
    const init = await rpc(app, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '0' } },
    }, { authorization: `Bearer ${ACTION_KEY}`, 'x-connection-id': CONN_1 });
    const called = await rpc(
      app,
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'create_doc', arguments: {} } },
      { authorization: `Bearer ${ACTION_KEY}`, 'x-connection-id': CONN_1, 'mcp-session-id': init.sessionId! },
    );
    const result = rpcResult(called.payload as never).result as {
      isError: boolean;
      content: [{ text: string }];
    };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('"code":"validation_error"');
  });

  it('returns 404 for unknown session ids', async () => {
    const { app } = makeServer();
    const res = await rpc(
      app,
      { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
      { authorization: `Bearer ${ACTION_KEY}`, 'x-connection-id': CONN_1, 'mcp-session-id': 'bogus-session' },
    );
    expect(res.status).toBe(404);
  });
});

describe('real MCP client over loopback HTTP (AC-5)', () => {
  let server: ServerType;
  let baseUrl: string;
  let harness: ReturnType<typeof makeServer>;

  beforeAll(async () => {
    harness = makeServer([
      {
        doc_id: 'mcp-sheet',
        title: 'MCP Sheet',
        content: '',
        sheet: { sheetId: 'sht-mcp', sheetName: 'Data', values: [['Q1', 10]] },
      },
      {
        doc_id: 'mcp-bit',
        title: 'MCP Bitable',
        content: '',
        bitable: new Map([['Leads', [{ record_id: 'rec_1', fields: { name: 'Ada' } }]]]),
      },
    ]);
    server = serve({ fetch: harness.app.fetch, port: 0 });
    await new Promise((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  async function connectedClient(key: string): Promise<Client> {
    const client = new Client({ name: 'totem-test-client', version: '0.0.0' }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: {
        headers: { authorization: `Bearer ${key}`, 'x-connection-id': CONN_1 },
      },
    });
    await client.connect(transport);
    return client;
  }

  it('lists tools, calls them, and returns structured results', async () => {
    const client = await connectedClient(ACTION_KEY);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toEqual([
      'create_doc',
      'search_docs',
      'get_doc_content',
      'get_doc_metadata',
      'append_doc_content',
      'rename_doc',
      'move_doc',
      'export_doc',
      'read_sheet_cells',
      'write_sheet_cells',
      'read_bitable_records',
      'write_bitable_records',
      'test_connection',
      ]);
      expect(tools[0]?.inputSchema).toMatchObject({ type: 'object' });

      const created = await client.callTool({
        name: 'create_doc',
        arguments: { title: 'via sdk client', content: 'Body from the SDK client.' },
      });
      expect(created.isError).toBeUndefined();
      expect(created.structuredContent).toMatchObject({ title: 'via sdk client' });
      const docId = (created.structuredContent as { doc_id: string }).doc_id;

      const read = await client.callTool({ name: 'get_doc_content', arguments: { doc_id: docId } });
      expect(read.structuredContent).toMatchObject({
        doc_id: docId,
        content: 'Body from the SDK client.',
      });

      // Writes flow through MCP too (T8): append and rename on the doc.
      const appended = await client.callTool({
        name: 'append_doc_content',
        arguments: { doc_id: docId, content: 'Appended line.' },
      });
      expect(appended.isError).toBeUndefined();
      expect(appended.structuredContent).toMatchObject({
        doc_id: docId,
        content: 'Body from the SDK client.\nAppended line.',
      });

      const renamed = await client.callTool({
        name: 'rename_doc',
        arguments: { doc_id: docId, new_title: 'SDK Renamed' },
      });
      expect(renamed.structuredContent).toMatchObject({ doc_id: docId, title: 'SDK Renamed' });

      // Advanced actions (T9) over MCP, non-DB: export, sheet cells, bitable.
      const exported = await client.callTool({
        name: 'export_doc',
        arguments: { doc_id: docId, format: 'pdf' },
      });
      expect(exported.isError).toBeUndefined();
      expect(exported.structuredContent).toMatchObject({ doc_id: docId, format: 'pdf' });

      const sheetRead = await client.callTool({
        name: 'read_sheet_cells',
        arguments: { doc_id: 'mcp-sheet', range: 'A1:B2' },
      });
      expect(sheetRead.structuredContent).toMatchObject({ values: [['Q1', 10], [null, null]] });

      const sheetWrite = await client.callTool({
        name: 'write_sheet_cells',
        arguments: { doc_id: 'mcp-sheet', sheet_name: 'Data', range: 'B2', values: [[42]] },
      });
      expect(sheetWrite.structuredContent).toMatchObject({ updated_cells: 1 });

      const bitableRead = await client.callTool({
        name: 'read_bitable_records',
        arguments: { doc_id: 'mcp-bit', table_name: 'Leads' },
      });
      expect(bitableRead.structuredContent).toMatchObject({
        records: [{ record_id: 'rec_1', fields: { name: 'Ada' } }],
      });

      const bitableWrite = await client.callTool({
        name: 'write_bitable_records',
        arguments: { doc_id: 'mcp-bit', table_name: 'Leads', fields: { name: 'Grace' } },
      });
      expect(bitableWrite.isError).toBeUndefined();
      expect((bitableWrite.structuredContent as { record_id: string }).record_id).toBeTruthy();
    } finally {
      await client.close();
    }
  });

  it('rejects an invalid key with 401 at connect time', async () => {
    const client = new Client({ name: 'totem-test-client', version: '0.0.0' }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: {
        headers: { authorization: 'Bearer tt_dev_absolutely_wrong', 'x-connection-id': CONN_1 },
      },
    });
    await expect(client.connect(transport)).rejects.toThrow();
  });

  it('returns isError results with the unified vocabulary for validation failures', async () => {
    const client = await connectedClient(ACTION_KEY);
    try {
      const invalid = await client.callTool({ name: 'create_doc', arguments: {} });
      expect(invalid.isError).toBe(true);
      const invalidText = (invalid.content as Array<{ type: string; text?: string }>)[0]?.text ?? '';
      expect(invalidText).toContain('"code":"validation_error"');
    } finally {
      await client.close();
    }
  });

  it('passes connector-mapped vocabulary errors through with their retryable flag', async () => {
    // get_doc_content on a missing document is a connector-owned `not_found`
    // (ADR-0005) thrown by the fake connector — it must survive the wire
    // as an isError result with the full vocabulary intact.
    const client = await connectedClient(ACTION_KEY);
    try {
      const missing = await client.callTool({ name: 'get_doc_content', arguments: { doc_id: 'doc_nope' } });
      expect(missing.isError).toBe(true);
      const missingText = (missing.content as Array<{ type: string; text?: string }>)[0]?.text ?? '';
      expect(missingText).toContain('"code":"not_found"');
      expect(missingText).toContain('"retryable":false');
    } finally {
      await client.close();
    }
  });

  it('a tool removed from the allowlist mid-session becomes unknown (-32602)', async () => {
    const client = await connectedClient(ACTION_KEY);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toContain('create_doc');

      // ADR-0002 hide-don't-reject: the tool disappears from the contract;
      // calling it is a stale-client error, never an execution attempt.
      harness.allowlists.setAllowed(TENANT_A, CONN_1, ['get_doc_content']);
      await expect(
        client.callTool({ name: 'create_doc', arguments: { title: 'x' } }),
      ).rejects.toMatchObject({ code: -32602 });
    } finally {
      await client.close();
    }
  });

  it('records MCP-originated executions in the audit log', async () => {
    // The allowlist narrowing test above may have run first; restore the
    // full allowlist so this test's call executes.
    harness.allowlists.setAllowed(TENANT_A, CONN_1, [
      'create_doc',
      'search_docs',
      'get_doc_content',
      'get_doc_metadata',
    ]);
    const client = await connectedClient(ACTION_KEY);
    const before = harness.audit.list().length;
    try {
      await client.callTool({ name: 'create_doc', arguments: { title: 'audited' } });
    } finally {
      await client.close();
    }
    const newRows = harness.audit.list().slice(before);
    expect(newRows).toHaveLength(1);
    expect(newRows[0]).toMatchObject({
      tenantId: TENANT_A,
      connectionId: CONN_1,
      actionName: 'create_doc',
      source: 'mcp',
      success: true,
      errorCode: null,
    });
  });
});
