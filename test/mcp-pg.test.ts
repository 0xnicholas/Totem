import { serve, type ServerType } from '@hono/node-server';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { migrateUp } from '../scripts/migrate.mjs';
import { PostgresAdminRepository } from '../src/admin/pg-repo.js';
import { generateApiKey, hashApiKey, keyPrefixForEnv } from '../src/admin/keys.js';
import { CONNECTION_ACTIONS, DOCS_ACTIONS, createActionExecutor } from '../src/index.js';
import { McpAdapter } from '../src/mcp/adapter.js';
import { PostgresMCPKeyStore, loadConnections } from '../src/mcp/pg-key-store.js';
import { createMcpApp } from '../src/mcp/server.js';
import { PostgresAllowlistStore, PostgresAuditSink } from '../src/pg-governance.js';
import { FakeConnector } from '../src/testing/fake-connector.js';

/**
 * Full-stack T5: Postgres-backed key verification, connection loading,
 * allowlist + audit stores, and a real MCP client over loopback HTTP
 * (AC-1..AC-5 against production-shaped stores). DB-gated like the other
 * integration files; applies migrations and truncates at start.
 */
const dbUrl = process.env.DATABASE_URL;
const hasDb = Boolean(dbUrl);

describe.runIf(hasDb)('MCP server end to end (Postgres)', () => {
  const pool = new pg.Pool({ connectionString: dbUrl });
  let server: ServerType;
  let baseUrl: string;
  let tenantId: string;
  let connectionId: string;
  let plaintextKey: string;
  let keyId: string;

  beforeAll(async () => {
    await migrateUp(dbUrl!);
    await pool.query("DELETE FROM tenants WHERE name NOT LIKE 'live-%'");

    const tenant = (
      await pool.query('INSERT INTO tenants (name) VALUES ($1) RETURNING id', ['mcp-e2e'])
    ).rows[0] as { id: string };
    tenantId = tenant.id;

    const connection = (
      await pool.query(
        `INSERT INTO connections (tenant_id, connector_id, name, owner_id)
         VALUES ($1, 'fake', 'mcp-conn', $2) RETURNING id`,
        [tenantId, tenantId],
      )
    ).rows[0] as { id: string };
    connectionId = connection.id;

    await pool.query(
      `INSERT INTO allowlists (tenant_id, connection_id, action_name)
       VALUES ($1, $2, 'create_doc'), ($1, $2, 'get_doc_content')`,
      [tenantId, connectionId],
    );

    const generated = generateApiKey(keyPrefixForEnv(false), 'actions');
    plaintextKey = generated.plaintext;
    const keyRow = (
      await pool.query<{ id: string }>(
        `INSERT INTO api_keys (tenant_id, prefix, key_hash, scope)
         VALUES ($1, $2, $3, 'actions') RETURNING id`,
        [tenantId, generated.prefix, generated.keyHash],
      )
    ).rows[0] as { id: string };
    keyId = keyRow.id;

    const connections = await loadConnections(pool);
    const executor = createActionExecutor({
      actions: [...DOCS_ACTIONS, ...CONNECTION_ACTIONS],
      connectors: [new FakeConnector()],
      connections,
      allowlists: new PostgresAllowlistStore(pool),
      audit: new PostgresAuditSink(pool),
    });
    const adapter = new McpAdapter(executor, new PostgresAllowlistStore(pool));
    const app = createMcpApp({ adapter, keys: new PostgresMCPKeyStore(pool) });
    server = serve({ fetch: app.fetch, port: 0 });
    await new Promise((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    // beforeAll may have failed (e.g. an unreachable database); guard so
    // teardown never masks the original error.
    if (server) await new Promise((resolve) => server.close(resolve));
    // Leave the database as found: truncate fixtures so repeated runs
    // against a dev DB never accumulate leftover tenants (issue #27).
    try {
      await pool.query("DELETE FROM tenants WHERE name NOT LIKE 'live-%'");
    } catch {
      // beforeAll may have failed (e.g. an unreachable database); never
      // mask the original error.
    }
    await pool.end();
  });

  it('lists only allowlisted tools for the connection (ADR-0002)', async () => {
    const client = await connectedClient(plaintextKey);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toEqual(['create_doc', 'get_doc_content']);
    } finally {
      await client.close();
    }
  });

  it('executes a tool call and lands a source-mcp audit row', async () => {
    const client = await connectedClient(plaintextKey);
    try {
      const created = await client.callTool({
        name: 'create_doc',
        arguments: { title: 'pg round trip' },
      });
      expect(created.isError).toBeUndefined();
      expect(created.structuredContent).toMatchObject({ title: 'pg round trip' });
    } finally {
      await client.close();
    }

    const repo = new PostgresAdminRepository(pool);
    const rows = await repo.queryAudit(tenantId, {});
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      connectionId,
      actionName: 'create_doc',
      source: 'mcp',
      success: true,
      errorCode: null,
    });
  });

  it('hides allowlisted-out tools and rejects hidden tool calls with -32602', async () => {
    const client = await connectedClient(plaintextKey);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).not.toContain('search_docs');
      await expect(
        client.callTool({ name: 'search_docs', arguments: { query: 'q' } }),
      ).rejects.toMatchObject({ code: -32602 });
    } finally {
      await client.close();
    }
  });

  it('rejects invalid keys with 401 and never touches the tool surface', async () => {
    const client = new Client({ name: 'totem-e2e', version: '0.0.0' }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: {
        headers: { authorization: 'Bearer tt_dev_bogus_key', 'x-connection-id': connectionId },
      },
    });
    await expect(client.connect(transport)).rejects.toThrow();
  });

  it('records last_used_at on successful authentication', async () => {
    const row = (
      await pool.query<{ last_used_at: Date | null }>(
        'SELECT last_used_at FROM api_keys WHERE id = $1',
        [keyId],
      )
    ).rows[0];
    expect(row?.last_used_at).not.toBeNull();
  });

  it('only resolves enabled actions-scoped keys', async () => {
    const store = new PostgresMCPKeyStore(pool);
    await expect(store.findKey(hashApiKey(plaintextKey))).resolves.toEqual({
      tenantId,
      keyId,
    });
    await expect(store.findKey(hashApiKey('tt_dev_unknown_key'))).resolves.toBeUndefined();
  });

  async function connectedClient(key: string): Promise<Client> {
    const client = new Client({ name: 'totem-e2e', version: '0.0.0' }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: {
        headers: { authorization: `Bearer ${key}`, 'x-connection-id': connectionId },
      },
    });
    await client.connect(transport);
    return client;
  }
});
