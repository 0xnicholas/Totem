import { serve } from '@hono/node-server';
import pg from 'pg';
import { Hono } from 'hono';
import { PostgresAdminRepository } from '../admin/pg-repo.js';
import { createAdminApp } from '../admin/server.js';
import { DOCS_ACTIONS, createActionExecutor, createMcpApp, McpAdapter, loadConnections, PostgresMCPKeyStore } from '../index.js';
import { PostgresAllowlistStore, PostgresAuditSink } from '../pg-governance.js';
import { FakeConnector } from '../testing/fake-connector.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL is required (e.g. postgres://totem:totem@db:5432/totem)');
  process.exit(1);
}

const adminKey = process.env.TOTEM_ADMIN_KEY;
if (!adminKey) {
  console.error(
    'TOTEM_ADMIN_KEY is required: the bootstrap admin key for /admin routes. ' +
      'Admin-scoped tenant keys (`create-key --scope admin`) also authenticate.',
  );
  process.exit(1);
}

const port = Number(process.env.PORT ?? 3000);
const production = process.env.NODE_ENV === 'production';

const pool = new pg.Pool({ connectionString: databaseUrl });
const repo = new PostgresAdminRepository(pool);

// v1 ships exactly one connector implementation: the in-memory fake used
// for local demos and the T5 integration story. T6+ swaps in the Feishu
// Docs connector here; the wiring below does not change.
const connectors = [new FakeConnector()];
const registeredConnectorIds = new Set(connectors.map((c) => c.manifest.id));
const connections = (await loadConnections(pool)).filter((connection) => {
  if (registeredConnectorIds.has(connection.connectorId)) return true;
  console.warn(
    `skipping connection ${connection.connectionId}: connector "${connection.connectorId}" is not registered`,
  );
  return false;
});

const allowlists = new PostgresAllowlistStore(pool);
const executor = createActionExecutor({
  actions: DOCS_ACTIONS,
  connectors,
  connections,
  allowlists,
  audit: new PostgresAuditSink(pool),
});

const adminApp = createAdminApp({ repo, adminKey, production });
const mcpApp = createMcpApp({
  adapter: new McpAdapter(executor, allowlists),
  keys: new PostgresMCPKeyStore(pool),
});

// One process, one port: /admin/* is the operator surface, /mcp is the
// agent surface (Streamable HTTP, bearer tenant keys).
const app = new Hono();
app.route('/', adminApp);
app.route('/mcp', mcpApp);
app.notFound((c) => c.json({ error: 'route not found' }, 404));
app.onError((err, c) => {
  console.error(err);
  return c.json({ error: 'internal_error' }, 500);
});

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`totem API listening on http://localhost:${info.port} (admin /admin, MCP /mcp)`);
});
