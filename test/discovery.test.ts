import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { serve, type ServerType } from '@hono/node-server';
import type { AddressInfo } from 'node:net';
import pg from 'pg';
import { migrateUp } from '../scripts/migrate.mjs';
import { generateApiKey, keyPrefixForEnv } from '../src/admin/keys.js';
import { createDiscoveryApp } from '../src/rest/discovery.js';
import { InMemoryMCPKeyStore } from '../src/testing/memory-key-store.js';
import { PostgresMCPKeyStore } from '../src/mcp/pg-key-store.js';
import { EXPORT_DEPRECATION, PLATFORM_ACTIONS, makeDeprecatedAction } from './fixtures.js';

const DISCOVERY_KEY = 'tt_dev_discovery_key';

describe('REST discovery surface (T12, HTTP boundary)', () => {
  let server: ServerType;
  let baseUrl: string;

  beforeAll(async () => {
    const keys = new InMemoryMCPKeyStore();
    keys.addKey(DISCOVERY_KEY, 'tenant-a');
    keys.addKey('tt_dev_admin_scoped', 'tenant-a', { scope: 'admin' });
    keys.addKey('tt_dev_disabled', 'tenant-a', { disabled: true });
    const app = createDiscoveryApp({ actions: PLATFORM_ACTIONS, keys });
    server = serve({ fetch: app.fetch, port: 0 });
    await new Promise((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  function discover(path: string, init: RequestInit = {}): Promise<Response> {
    return fetch(`${baseUrl}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${DISCOVERY_KEY}` },
    });
  }

  it('GET /actions lists the platform action set as metadata (the registry\'s visible view)', async () => {
    const response = await discover('/actions');
    expect(response.status).toBe(200);
    const body = (await response.json()) as { actions: Array<{ name: string; description: string; effects: string }> };
    const names = body.actions.map((a) => a.name);
    // The surface renders the view it is given, in the order given — the
    // hidden filter and the advertised ordering live once in
    // ActionRegistry.visibleActions() (pinned in registry-visibility.test.ts);
    // this fixture passes the platform set in registration order.
    expect(names).toEqual(PLATFORM_ACTIONS.map((a) => a.name));
    expect(names).toHaveLength(13);
    const createDoc = body.actions.find((a) => a.name === 'create_doc');
    expect(createDoc).toMatchObject({ effects: 'write' });
    expect(typeof createDoc?.description).toBe('string');
    const testConnection = body.actions.find((a) => a.name === 'test_connection');
    expect(testConnection).toMatchObject({ effects: 'read' });
    expect(typeof testConnection?.description).toBe('string');
  });

  it('GET /actions carries provider on provider-native actions and omits it on canonical ones', async () => {
    const response = await discover('/actions');
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      actions: Array<{ name: string; provider?: string }>;
    };
    for (const action of body.actions) {
      if (action.name.startsWith('feishu_')) {
        expect(action, action.name).toHaveProperty('provider', 'feishu');
      } else {
        expect(action, action.name).not.toHaveProperty('provider');
      }
    }
  });

  it('GET /actions exposes deprecated when present and omits it when absent', async () => {
    const deprecation = { ...EXPORT_DEPRECATION, note: 'Migrate at leisure.' };
    const deprecated = makeDeprecatedAction({ deprecated: deprecation });
    const keys = new InMemoryMCPKeyStore();
    keys.addKey('tt_dev_deprecated_test', 'tenant-a');
    const app = createDiscoveryApp({ actions: [...PLATFORM_ACTIONS, deprecated], keys });
    const res = await app.fetch(new Request('http://localhost/actions', {
      headers: { authorization: 'Bearer tt_dev_deprecated_test' },
    }));
    const body = (await res.json()) as {
      actions: Array<{ name: string; deprecated?: unknown }>;
    };
    expect(body.actions.find((a) => a.name === 'legacy_export')).toHaveProperty(
      'deprecated',
      deprecation,
    );
    // Every non-deprecated action omits the key entirely — the flag is
    // additive, like provider scope.
    for (const action of body.actions) {
      if (action.name !== 'legacy_export') {
        expect(action, action.name).not.toHaveProperty('deprecated');
      }
    }
  });

  it('POST /actions/search carries deprecated metadata like the list endpoint', async () => {
    const deprecated = makeDeprecatedAction();
    const keys = new InMemoryMCPKeyStore();
    keys.addKey('tt_dev_deprecated_search', 'tenant-a');
    const app = createDiscoveryApp({ actions: [...PLATFORM_ACTIONS, deprecated], keys });
    const res = await app.fetch(new Request('http://localhost/actions/search', {
      method: 'POST',
      headers: {
        authorization: 'Bearer tt_dev_deprecated_search',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ query: 'legacy' }),
    }));
    const body = (await res.json()) as {
      actions: Array<{ name: string; deprecated?: unknown }>;
    };
    expect(body.actions).toHaveLength(1);
    expect(body.actions[0]).toMatchObject({
      name: 'legacy_export',
      deprecated: EXPORT_DEPRECATION,
    });
  });

  it('POST /actions/search matches names and descriptions, case-insensitive', async () => {
    // 'sheet' hits the two sheet actions by name and get_doc_metadata by
    // description ("docx, sheet, bitable, wiki").
    const byName = await discover('/actions/search', {
      method: 'POST',
      body: JSON.stringify({ query: 'sheet' }),
    });
    const nameBody = (await byName.json()) as { actions: Array<{ name: string }> };
    expect(nameBody.actions.map((a) => a.name).sort()).toEqual([
      'get_doc_metadata',
      'read_sheet_cells',
      'write_sheet_cells',
    ]);

    const byDescription = await discover('/actions/search', {
      method: 'POST',
      body: JSON.stringify({ query: 'append' }),
    });
    const descBody = (await byDescription.json()) as { actions: Array<{ name: string }> };
    expect(descBody.actions.map((a) => a.name)).toEqual(['append_doc_content']);

    // Case-insensitive: 'CREATE' hits create_doc by name and
    // append_doc_content / feishu_write_bitable_records by description.
    const mixed = await discover('/actions/search', {
      method: 'POST',
      body: JSON.stringify({ query: 'CREATE' }),
    });
    const mixedBody = (await mixed.json()) as { actions: Array<{ name: string }> };
    expect(mixedBody.actions.map((a) => a.name).sort()).toEqual([
      'append_doc_content',
      'create_doc',
      'feishu_write_bitable_records',
    ]);

    const none = await discover('/actions/search', {
      method: 'POST',
      body: JSON.stringify({ query: 'zzz-nothing' }),
    });
    const noneBody = (await none.json()) as { query: string; actions: unknown[] };
    expect(noneBody).toEqual({ query: 'zzz-nothing', actions: [] });
  });

  it('POST /actions/search carries provider metadata like the list endpoint', async () => {
    // 'bitable' hits the two provider-native actions by name and
    // get_doc_metadata (canonical) by description — one response mixing
    // both scopes.
    const native = await discover('/actions/search', {
      method: 'POST',
      body: JSON.stringify({ query: 'bitable' }),
    });
    const nativeBody = (await native.json()) as {
      actions: Array<{ name: string; provider?: string }>;
    };
    expect(nativeBody.actions.map((a) => a.name).sort()).toEqual([
      'feishu_read_bitable_records',
      'feishu_write_bitable_records',
      'get_doc_metadata',
    ]);
    expect(
      nativeBody.actions.find((a) => a.name === 'feishu_read_bitable_records'),
    ).toHaveProperty('provider', 'feishu');
    expect(
      nativeBody.actions.find((a) => a.name === 'feishu_write_bitable_records'),
    ).toHaveProperty('provider', 'feishu');
    expect(nativeBody.actions.find((a) => a.name === 'get_doc_metadata')).not.toHaveProperty(
      'provider',
    );

    // Canonical matches omit the key entirely.
    const canonical = await discover('/actions/search', {
      method: 'POST',
      body: JSON.stringify({ query: 'append' }),
    });
    const canonicalBody = (await canonical.json()) as {
      actions: Array<{ name: string; description: string; provider?: string }>;
    };
    expect(canonicalBody.actions).toHaveLength(1);
    expect(canonicalBody.actions[0]).toMatchObject({
      name: 'append_doc_content',
      effects: 'write',
    });
    expect(typeof canonicalBody.actions[0]?.description).toBe('string');
    expect(canonicalBody.actions[0]).not.toHaveProperty('provider');
  });

  it('rejects empty or missing search queries with 400', async () => {
    for (const body of [undefined, {}, { query: '' }, { query: '   ' }, { query: 42 }]) {
      const response = await discover('/actions/search', {
        method: 'POST',
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
  });
});

describe.runIf(Boolean(process.env.DATABASE_URL))('REST discovery with the Postgres key store', () => {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  let server: ServerType;
  let baseUrl: string;
  let plaintextKey: string;

  beforeAll(async () => {
    await migrateUp(process.env.DATABASE_URL!);
    await pool.query("DELETE FROM tenants WHERE name NOT LIKE 'live-%'");
    const tenant = (
      await pool.query<{ id: string }>("INSERT INTO tenants (name) VALUES ('discovery-pg') RETURNING id")
    ).rows[0]!;
    const generated = generateApiKey(keyPrefixForEnv(false), 'actions');
    plaintextKey = generated.plaintext;
    await pool.query(
      `INSERT INTO api_keys (tenant_id, prefix, key_hash, scope) VALUES ($1, $2, $3, 'actions')`,
      [tenant.id, generated.prefix, generated.keyHash],
    );
    const app = createDiscoveryApp({
      actions: PLATFORM_ACTIONS,
      keys: new PostgresMCPKeyStore(pool),
    });
    server = serve({ fetch: app.fetch, port: 0 });
    await new Promise((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
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

  it('resolves a stored tenant key for GET /actions', async () => {
    const response = await fetch(`${baseUrl}/actions`, {
      headers: { authorization: `Bearer ${plaintextKey}` },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { actions: unknown[] };
    expect(body.actions).toHaveLength(13);
  });
});
