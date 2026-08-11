/**
 * Live DingTalk pass — follow-up driver (authorize already done). Runs the
 * read/write/export surface against the EXISTING live connection, with raw
 * response printing for diagnosis.
 *
 * Env: TOTEM_ADMIN_KEY, ADMIN_BASE (default http://localhost:3200),
 * TENANT_ID, CONNECTION_ID, DATABASE_URL, TOTEM_TOKEN_ENC_KEY,
 * FOLDER_ID (optional).
 */
import { AdminApiClient } from '../src/admin/client.js';
import { DingTalkConnector } from '../src/dingtalk/connector.js';
import { decryptValue } from '../src/feishu/crypto.js';
import pg from 'pg';

const ADMIN_BASE = process.env.ADMIN_BASE ?? 'http://localhost:3200';
const ADMIN_KEY = process.env.TOTEM_ADMIN_KEY!;
const TENANT_ID = process.env.TENANT_ID!;
const CONNECTION_ID = process.env.CONNECTION_ID!;
const FOLDER_ID = process.env.FOLDER_ID;

const FINDINGS: string[] = [];
const log = (msg: string) => console.log(`[live] ${msg}`);
const finding = (msg: string) => {
  FINDINGS.push(msg);
  console.log(`[finding] ${msg}`);
};

const admin = new AdminApiClient({ baseUrl: ADMIN_BASE, apiKey: ADMIN_KEY });

async function rawRpc(
  key: string,
  action: string,
  args: Record<string, unknown>,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${ADMIN_BASE}/actions/rpc`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${key}`,
      'x-connection-id': CONNECTION_ID,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ action, args }),
  });
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = `(non-JSON body: ${(await res.text()).slice(0, 200)})`;
  }
  return { status: res.status, body };
}

async function main() {
  const key = (await admin.createKey(TENANT_ID, 'actions')).key;
  await admin.setAllowlist(CONNECTION_ID, [
    'test_connection',
    'search_docs',
    'get_doc_content',
    'get_doc_metadata',
    'create_doc',
    'append_doc_content',
    'rename_doc',
    'move_doc',
  ]);
  log(`allowlist set for ${CONNECTION_ID}`);

  // --- search with a real keyword (empty query is schema-rejected) ---
  for (const query of ['文档', '项目', 'a']) {
    const { status, body } = await rawRpc(key, 'search_docs', { query, limit: 5 });
    log(`search_docs(${JSON.stringify(query)}): HTTP ${status} ${JSON.stringify(body).slice(0, 400)}`);
    if (status === 200) {
      const docs = (body as { data?: Array<{ doc_id: string; title: string }> })?.data ?? [];
      finding(`search_docs("${query}"): ${docs.length} docs: ${docs.map((d) => `${d.doc_id} (${d.title})`).join(', ') || 'none'}`);
      if (docs.length > 0) break;
    }
  }

  // --- create + read-back ---
  const createArgs = {
    title: `totem-live-${Date.now()}`,
    content: '# Totem live pass\n\nCreated by the T17 live verification.',
  };
  const created = await rawRpc(key, 'create_doc', createArgs);
  log(`create_doc: HTTP ${created.status} ${JSON.stringify(created.body)}`);
  const docId = (created.body as { doc_id?: string }).doc_id;
  if (!docId) {
    finding(`create_doc FAILED (HTTP ${created.status}): ${JSON.stringify(created.body).slice(0, 300)}`);
    printFindings();
    return;
  }
  finding(`create_doc: doc_id=${docId} (create with initial content OK)`);

  const content = await rawRpc(key, 'get_doc_content', { doc_id: docId });
  log(`get_doc_content(created): HTTP ${content.status} ${JSON.stringify(content.body).slice(0, 300)}`);
  if (content.status === 200) {
    finding('get_doc_content on the created doc OK (initial content readable)');
  } else {
    finding(`get_doc_content FAILED: ${JSON.stringify(content.body).slice(0, 200)}`);
  }

  const meta = await rawRpc(key, 'get_doc_metadata', { doc_id: docId });
  log(`get_doc_metadata: HTTP ${meta.status} ${JSON.stringify(meta.body).slice(0, 300)}`);
  if (meta.status === 200) {
    finding(`get_doc_metadata OK: ${JSON.stringify(meta.body)}`);
  } else {
    finding(`get_doc_metadata FAILED: ${JSON.stringify(meta.body).slice(0, 200)}`);
  }

  const appended = await rawRpc(key, 'append_doc_content', {
    doc_id: docId,
    content: 'Appended by the live pass.',
  });
  log(`append_doc_content: HTTP ${appended.status} ${JSON.stringify(appended.body).slice(0, 300)}`);
  if (appended.status === 200) {
    finding('append_doc_content OK (full updated content returned)');
  } else {
    finding(`append_doc_content FAILED: ${JSON.stringify(appended.body).slice(0, 200)}`);
  }

  const renamed = await rawRpc(key, 'rename_doc', {
    doc_id: docId,
    new_title: `totem-live-renamed-${Date.now()}`,
  });
  log(`rename_doc: HTTP ${renamed.status} ${JSON.stringify(renamed.body).slice(0, 300)}`);
  if (renamed.status === 200) {
    finding('rename_doc OK');
  } else {
    finding(`rename_doc FAILED: ${JSON.stringify(renamed.body).slice(0, 200)}`);
  }

  if (FOLDER_ID) {
    const moved = await rawRpc(key, 'move_doc', { doc_id: docId, folder_id: FOLDER_ID });
    log(`move_doc: HTTP ${moved.status} ${JSON.stringify(moved.body).slice(0, 300)}`);
    if (moved.status === 200) {
      finding(`move_doc OK (into folder ${FOLDER_ID})`);
    } else {
      finding(`move_doc FAILED: ${JSON.stringify(moved.body).slice(0, 200)}`);
    }
  } else {
    log('move_doc skipped (no FOLDER_ID)');
  }

  // --- hidden export translation, direct connector call with the real token ---
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const row = (
    await pool.query<{ user_access_token: string }>(
      'SELECT user_access_token FROM tokens WHERE connection_id = $1',
      [CONNECTION_ID],
    )
  ).rows[0];
  await pool.end();
  if (!row) {
    finding('export check skipped: no token row');
  } else {
    const token = decryptValue(TENANT_ID, row.user_access_token, process.env.TOTEM_TOKEN_ENC_KEY!);
    const appToken = await fetch('https://api.dingtalk.com/v1.0/oauth2/accessToken', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ appKey: process.env.APP_KEY, appSecret: process.env.APP_SECRET }),
    })
      .then((r) => r.json())
      .then((b) => (b as { accessToken: string }).accessToken);
    const connector = new DingTalkConnector('https://api.dingtalk.com', {
      getAppAccessToken: () => Promise.resolve(appToken),
      exportPollMs: 3000,
      exportMaxAttempts: 40,
    });
    for (const format of ['docx', 'pdf'] as const) {
      try {
        const out = await connector.execute(
          'export_doc',
          { doc_id: docId, format },
          { tenantId: TENANT_ID, connectionId: CONNECTION_ID, token },
        );
        log(`export_doc(${format}): ${JSON.stringify(out)}`);
        finding(`export_doc(${format}) OK — exportType ${format === 'docx' ? 'dingTalkDocToDocx' : 'dingTalkDocToPdf'} CONFIRMED LIVE`);
      } catch (err) {
        const e = err as { code?: string; message?: string; upstream?: unknown };
        log(`export_doc(${format}) error: ${e.code} ${e.message} upstream=${JSON.stringify(e.upstream)}`);
        finding(`export_doc(${format}) FAILED: ${e.code} ${e.message} upstream=${JSON.stringify(e.upstream)}`);
      }
    }
  }

  printFindings();
}

function printFindings() {
  console.log('\n===== FINDINGS =====');
  for (const f of FINDINGS) console.log(`- ${f}`);
}

main().catch((err) => {
  console.error('[live] fatal:', err);
  process.exitCode = 1;
});
