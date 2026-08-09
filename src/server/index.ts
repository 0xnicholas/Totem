import { serve } from '@hono/node-server';
import pg from 'pg';
import { PostgresAdminRepository } from '../admin/pg-repo.js';
import { createAdminApp } from '../admin/server.js';

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
const app = createAdminApp({ repo: new PostgresAdminRepository(pool), adminKey, production });

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`totem admin API listening on http://localhost:${info.port}`);
});
