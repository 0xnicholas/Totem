/**
 * Live DingTalk pass — T18a driver (authorize already done). Exercises the
 * workbook sheet surface (read_sheet_cells / write_sheet_cells) against a
 * REAL DingTalk workbook, with raw response printing for diagnosis.
 *
 * Operator prerequisites (T18a):
 * - the app's permission scope grants `Document.Workbook.Read` +
 *   `Document.Workbook.Write` (企业内部应用 only) — if a permission point
 *   is ungrantable, keep the affected Action hidden (T17 export precedent);
 * - WORKBOOK_ID = an existing workbook's nodeId(dentryUuid) — the opaque
 *   doc_id. (Creating a workbook fixture via the create API's table
 *   documentType is a parent-#32 ops item — the platform create_doc only
 *   makes online documents, and the table documentType is live-discovery.)
 * - WORKBOOK_SHEET (default 'Sheet1') = a worksheet display name inside
 *   that workbook (the platform has no sheet-list action, so the driver
 *   cannot discover names through RPC).
 *
 * Env: TOTEM_ADMIN_KEY, ADMIN_BASE (default http://localhost:3200),
 * TENANT_ID, CONNECTION_ID, WORKBOOK_ID, WORKBOOK_SHEET (optional).
 */
import { AdminApiClient } from '../src/admin/client.js';

const ADMIN_BASE = process.env.ADMIN_BASE ?? 'http://localhost:3200';
const ADMIN_KEY = process.env.TOTEM_ADMIN_KEY!;
const TENANT_ID = process.env.TENANT_ID!;
const CONNECTION_ID = process.env.CONNECTION_ID!;
const WORKBOOK_ID = process.env.WORKBOOK_ID;
const WORKBOOK_SHEET = process.env.WORKBOOK_SHEET ?? 'Sheet1';

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
  if (!WORKBOOK_ID) {
    console.error('[live] WORKBOOK_ID is required (an existing DingTalk workbook nodeId)');
    process.exitCode = 1;
    return;
  }

  const key = (await admin.createKey(TENANT_ID, 'actions')).key;
  await admin.setAllowlist(CONNECTION_ID, ['write_sheet_cells', 'read_sheet_cells']);
  log(`allowlist set for ${CONNECTION_ID}`);

  // --- write + read back with the explicit sheet name ---
  const writeArgs = {
    doc_id: WORKBOOK_ID,
    sheet_name: WORKBOOK_SHEET,
    range: 'A1:B2',
    // Native types: string, number, boolean — the live type round-trip.
    values: [
      ['totem-live', 42],
      [true, null],
    ],
  };
  const write = await rawRpc(key, 'write_sheet_cells', writeArgs);
  log(`write_sheet_cells: HTTP ${write.status} ${JSON.stringify(write.body)}`);
  if (write.status === 200) {
    const cells = (write.body as { updated_cells?: number }).updated_cells;
    finding(
      `write_sheet_cells OK — updated_cells=${cells} (computed as rows × cols; upstream returns only a1Notation)`,
    );
  } else {
    finding(`write_sheet_cells FAILED: ${JSON.stringify(write.body).slice(0, 300)}`);
    printFindings();
    return;
  }

  const readExplicit = await rawRpc(key, 'read_sheet_cells', {
    doc_id: WORKBOOK_ID,
    sheet_name: WORKBOOK_SHEET,
    range: 'A1:B2',
  });
  log(`read_sheet_cells(explicit): HTTP ${readExplicit.status} ${JSON.stringify(readExplicit.body)}`);
  if (readExplicit.status === 200) {
    finding(
      `read_sheet_cells(explicit name in the sheetId slot) OK: ${JSON.stringify((readExplicit.body as { data?: unknown }).data)}`,
    );
  } else {
    finding(`read_sheet_cells(explicit) FAILED: ${JSON.stringify(readExplicit.body).slice(0, 300)}`);
  }

  // --- first-worksheet resolution: sheet_name omitted ---
  const readOmitted = await rawRpc(key, 'read_sheet_cells', {
    doc_id: WORKBOOK_ID,
    range: 'A1:B2',
  });
  log(`read_sheet_cells(omitted): HTTP ${readOmitted.status} ${JSON.stringify(readOmitted.body)}`);
  if (readOmitted.status === 200) {
    finding('read_sheet_cells(sheet_name omitted → first worksheet) OK');
  } else {
    finding(`read_sheet_cells(omitted) FAILED: ${JSON.stringify(readOmitted.body).slice(0, 300)}`);
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
