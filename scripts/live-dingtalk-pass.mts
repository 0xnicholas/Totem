/**
 * Live DingTalk verification driver (T17 family live pass — unblocks
 * #29/#30/#31). Operator tooling: run with the real app credentials,
 * follow the printed authorize URL in a browser, and the script walks the
 * whole surface: test_connection, reads, writes, and the hidden export
 * translation (direct connector call with the real token).
 *
 * Usage:
 *   APP_KEY=... APP_SECRET=... npx tsx scripts/live-dingtalk-pass.mts [--folder <folderId>]
 *
 * Env: ADMIN_BASE (default http://localhost:3200), TOTEM_ADMIN_KEY,
 * DATABASE_URL, TOTEM_TOKEN_ENC_KEY (for decrypting the token for the
 * export check), TENANT_NAME (default 'live-dingtalk-pass').
 * --folder: a real DingTalk folder dentryUuid for move_doc (optional; the
 * move step is skipped without it).
 */
import { AdminApiClient } from '../src/admin/client.js';
import { DingTalkConnector } from '../src/dingtalk/connector.js';
import { decryptValue } from '../src/feishu/crypto.js';
import pg from 'pg';

const APP_KEY = process.env.APP_KEY!;
const APP_SECRET = process.env.APP_SECRET!;
const ADMIN_BASE = process.env.ADMIN_BASE ?? 'http://localhost:3200';
const ADMIN_KEY = process.env.TOTEM_ADMIN_KEY!;
const TENANT_NAME = process.env.TENANT_NAME ?? 'live-dingtalk-pass';
const FOLDER_ID = process.argv.includes('--folder')
  ? process.argv[process.argv.indexOf('--folder') + 1]
  : undefined;

const FINDINGS: string[] = [];
const log = (msg: string) => console.log(`[live] ${msg}`);
const finding = (msg: string) => {
  FINDINGS.push(msg);
  console.log(`[finding] ${msg}`);
};

const admin = new AdminApiClient({ baseUrl: ADMIN_BASE, apiKey: ADMIN_KEY });

async function rpc(
  connectionId: string,
  key: string,
  action: string,
  args: Record<string, unknown>,
): Promise<{ ok: boolean; output?: unknown; error?: { code: string; message: string } }> {
  const res = await fetch(`${ADMIN_BASE}/actions/rpc`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${key}`,
      'x-connection-id': connectionId,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ action, args }),
  });
  const body = (await res.json()) as {
    ok?: boolean;
    output?: unknown;
    error?: { code: string; message: string };
  };
  return { ok: res.status === 200 && body.ok !== false, ...body };
}

async function main() {
  if (!APP_KEY || !APP_SECRET) throw new Error('APP_KEY / APP_SECRET env required');
  if (!ADMIN_KEY) throw new Error('TOTEM_ADMIN_KEY env required');

  log('creating tenant');
  const tenant = await admin.createTenant(TENANT_NAME);
  log(`tenant ${tenant.id} (${tenant.name})`);

  log('storing dingtalk credentials (ciphertext at rest)');
  await admin.setDingTalkCreds(tenant.id, APP_KEY, APP_SECRET);

  log('starting authorize flow');
  const redirectUri = `${ADMIN_BASE}/oauth/callback/dingtalk`;
  const { authorizationUrl } = await admin.startOAuth(
    tenant.id,
    redirectUri,
    undefined,
    'dingtalk_docs',
  );
  console.log(`\n>>> OPEN IN A BROWSER (logged in as the test DingTalk user) and authorize:\n${authorizationUrl}\n`);

  log('waiting for the user to authorize (polling connections)…');
  let connectionId: string | undefined;
  for (let i = 0; i < 120; i++) {
    const { connections } = await admin.listConnections(tenant.id);
    const conn = connections.find((c) => c.connectorId === 'dingtalk_docs');
    if (conn && conn.status === 'active') {
      connectionId = conn.id;
      break;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  if (!connectionId) {
    finding('AUTHORIZE FLOW: no active dingtalk_docs connection within 4 minutes');
    process.exitCode = 1;
    return;
  }
  log(`connection ${connectionId} active`);

  const key = (await admin.createKey(tenant.id, 'actions')).key;
  await admin.setAllowlist(connectionId, [
    'test_connection',
    'search_docs',
    'get_doc_content',
    'get_doc_metadata',
    'create_doc',
    'append_doc_content',
    'rename_doc',
    'move_doc',
  ]);

  // --- connection ---
  const tc = await rpc(connectionId, key, 'test_connection', {});
  log(`test_connection: ${JSON.stringify(tc)}`);
  if (!tc.ok) finding(`test_connection FAILED: ${tc.error?.code} ${tc.error?.message}`);

  // --- reads ---
  const search = await rpc(connectionId, key, 'search_docs', { query: '', limit: 5 });
  log(`search_docs: ${JSON.stringify(search).slice(0, 600)}`);
  const docs = ((search.output ?? {}) as { data?: Array<{ doc_id: string; title: string }> }).data ?? [];
  finding(
    `search_docs: ${docs.length} dentries returned; ALIDOC-filtered docs: ${docs.map((d) => `${d.doc_id} (${d.title})`).join(', ') || 'none'}`,
  );
  const readDocId = docs[0]?.doc_id;

  if (readDocId) {
    const content = await rpc(connectionId, key, 'get_doc_content', { doc_id: readDocId });
    log(`get_doc_content: ok=${content.ok} len=${String((content.output as { content?: string })?.content ?? '').length}`);
    if (!content.ok) finding(`get_doc_content FAILED: ${content.error?.code} ${content.error?.message}`);
    const meta = await rpc(connectionId, key, 'get_doc_metadata', { doc_id: readDocId });
    log(`get_doc_metadata: ${JSON.stringify(meta.output ?? meta.error)}`);
    if (!meta.ok) finding(`get_doc_metadata FAILED: ${meta.error?.code} ${meta.error?.message}`);
  } else {
    finding('no searchable doc found — reads limited to the created doc below');
  }

  // --- writes ---
  const created = await rpc(connectionId, key, 'create_doc', {
    title: `totem-live-${Date.now()}`,
    content: '# Totem live pass\n\nCreated by the T17 live verification.',
  });
  log(`create_doc: ${JSON.stringify(created.output ?? created.error)}`);
  if (!created.ok) {
    finding(`create_doc FAILED: ${created.error?.code} ${created.error?.message}`);
  } else {
    const docId = (created.output as { doc_id: string }).doc_id;
    finding(`create_doc: doc_id=${docId}`);

    const appended = await rpc(connectionId, key, 'append_doc_content', {
      doc_id: docId,
      content: 'Appended by the live pass.',
    });
    log(`append_doc_content: ${JSON.stringify(appended.output ?? appended.error)}`);
    if (!appended.ok) finding(`append_doc_content FAILED: ${appended.error?.code} ${appended.error?.message}`);

    const renamed = await rpc(connectionId, key, 'rename_doc', {
      doc_id: docId,
      new_title: `totem-live-renamed-${Date.now()}`,
    });
    log(`rename_doc: ${JSON.stringify(renamed.output ?? renamed.error)}`);
    if (!renamed.ok) finding(`rename_doc FAILED: ${renamed.error?.code} ${renamed.error?.message}`);

    if (FOLDER_ID) {
      const moved = await rpc(connectionId, key, 'move_doc', { doc_id: docId, folder_id: FOLDER_ID });
      log(`move_doc: ${JSON.stringify(moved.output ?? moved.error)}`);
      if (!moved.ok) finding(`move_doc FAILED: ${moved.error?.code} ${moved.error?.message}`);
    } else {
      log('move_doc skipped (pass --folder <dentryUuid> to exercise it)');
    }

    // --- hidden export translation, direct connector call with the real token ---
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    const row = (
      await pool.query<{ user_access_token: string }>(
        'SELECT user_access_token FROM tokens WHERE connection_id = $1',
        [connectionId],
      )
    ).rows[0];
    await pool.end();
    if (!row) {
      finding('export check skipped: no token row found');
    } else {
      const token = decryptValue(
        (await admin.listConnections(tenant.id)).connections[0]!.ownerId,
        row.user_access_token,
        process.env.TOTEM_TOKEN_ENC_KEY!,
      );
      const connector = new DingTalkConnector('https://api.dingtalk.com', { exportPollMs: 3000, exportMaxAttempts: 40 });
      for (const format of ['docx', 'pdf']) {
        try {
          const out = await connector.execute(
            'export_doc',
            { doc_id: docId, format },
            { tenantId: tenant.id, connectionId, token },
          );
          log(`export_doc(${format}): ${JSON.stringify(out)}`);
          finding(`export_doc(${format}) OK: exportType=${format === 'docx' ? 'dingTalkDocToDocx' : 'dingTalkDocToPdf'}`);
        } catch (err) {
          const e = err as { code?: string; message?: string };
          finding(`export_doc(${format}) FAILED: ${e.code} ${e.message}`);
        }
      }
    }
  }

  console.log('\n===== FINDINGS =====');
  for (const f of FINDINGS) console.log(`- ${f}`);
}

main().catch((err) => {
  console.error('[live] fatal:', err);
  process.exitCode = 1;
});
