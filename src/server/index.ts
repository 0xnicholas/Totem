import { serve } from '@hono/node-server';
import pg from 'pg';
import { composeServer } from './compose.js';

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

const masterKey = process.env.TOTEM_TOKEN_ENC_KEY;
if (!masterKey) {
  console.error(
    'TOTEM_TOKEN_ENC_KEY is required: the master key for per-tenant secret ' +
      'encryption at rest (ADR-0004, issue #15). Generate one, e.g. ' +
      '`openssl rand -hex 32`.',
  );
  process.exit(1);
}
if (masterKey.length < 32) {
  console.error(
    'TOTEM_TOKEN_ENC_KEY must be at least 32 characters (it is the master ' +
      'key every stored secret is derived from).',
  );
  process.exit(1);
}

const port = Number(process.env.PORT ?? 3000);
const production = process.env.NODE_ENV === 'production';

const pool = new pg.Pool({ connectionString: databaseUrl });
const app = composeServer(pool, {
  masterKey,
  adminKey,
  production,
  feishuBaseUrl: process.env.FEISHU_BASE_URL,
});

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`totem API listening on http://localhost:${info.port} (admin /admin, MCP /mcp)`);
});
