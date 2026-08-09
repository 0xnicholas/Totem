import { serve, type ServerType } from '@hono/node-server';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFeishuOAuthClient } from '../src/feishu/oauth.js';
import { MockFeishuServer } from '../src/testing/mock-feishu-server.js';

const APP_ID = 'adv_app_id';
const APP_SECRET = 'adv_app_secret';
const REDIRECT_URI = 'https://totem.example.com/oauth/callback/feishu';

/**
 * Seam B advanced contract (T9): the mock's export-task, spreadsheet and
 * Bitable endpoints — drive export_tasks (create + poll), sheets v2 values
 * (read range, write range) and bitable apps/tables/records. Pinned here so
 * the connector can rely on the shapes without re-deriving them.
 */
describe('MockFeishuServer advanced endpoints', () => {
  let server: ServerType;
  let baseUrl: string;
  let mock: MockFeishuServer;
  let accessToken: string;

  beforeAll(async () => {
    mock = new MockFeishuServer({ appId: APP_ID, appSecret: APP_SECRET });
    mock.seedDocs([
      {
        doc_id: 'adv-doc',
        title: 'Exportable',
        content: '# Exportable\n\nBody.',
        owner_id: 'user-1',
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
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  function fetchApi(path: string, init: RequestInit = {}): Promise<Response> {
    return fetch(`${baseUrl}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
        ...(init.headers ?? {}),
      },
    });
  }

  describe('export tasks', () => {
    it('creates an export task and completes it with a file token', async () => {
      const created = await fetchApi('/open-apis/drive/v1/export_tasks', {
        method: 'POST',
        body: JSON.stringify({ file_extension: 'md', token: 'adv-doc' }),
      });
      const envelope = (await created.json()) as { code: number; data: { ticket: string } };
      expect(envelope.code).toBe(0);
      expect(envelope.data.ticket).toBeTruthy();

      const polled = await fetchApi(
        `/open-apis/drive/v1/export_tasks/${envelope.data.ticket}`,
      );
      const poll = (await polled.json()) as {
        code: number;
        data: { job_status: number; result: { file_token: string } };
      };
      expect(poll.code).toBe(0);
      expect(poll.data.job_status).toBe(0);
      expect(poll.data.result.file_token).toBeTruthy();
    });

    it('reports job_status 1 while held, then completes', async () => {
      mock.holdNextExport();
      const created = await fetchApi('/open-apis/drive/v1/export_tasks', {
        method: 'POST',
        body: JSON.stringify({ file_extension: 'docx', token: 'adv-doc' }),
      });
      const envelope = (await created.json()) as { code: number; data: { ticket: string } };
      expect(envelope.code).toBe(0);

      const first = (await (
        await fetchApi(`/open-apis/drive/v1/export_tasks/${envelope.data.ticket}`)
      ).json()) as { code: number; data: { job_status: number } };
      expect(first.data.job_status).toBe(1);

      const second = (await (
        await fetchApi(`/open-apis/drive/v1/export_tasks/${envelope.data.ticket}`)
      ).json()) as { code: number; data: { job_status: number; result?: { file_token: string } } };
      expect(second.data.job_status).toBe(0);
      expect(second.data.result?.file_token).toBeTruthy();
    });

    it('fails the next export task with job_status 2', async () => {
      mock.failNextExport();
      const created = await fetchApi('/open-apis/drive/v1/export_tasks', {
        method: 'POST',
        body: JSON.stringify({ file_extension: 'md', token: 'adv-doc' }),
      });
      const envelope = (await created.json()) as { code: number; data: { ticket: string } };
      const polled = (await (
        await fetchApi(`/open-apis/drive/v1/export_tasks/${envelope.data.ticket}`)
      ).json()) as { code: number; data: { job_status: number; msg?: string } };
      expect(polled.data.job_status).toBe(2);
    });

    it('rejects exporting an unknown document with 10662', async () => {
      const created = await fetchApi('/open-apis/drive/v1/export_tasks', {
        method: 'POST',
        body: JSON.stringify({ file_extension: 'md', token: 'nope' }),
      });
      const envelope = (await created.json()) as { code: number };
      expect(envelope.code).toBe(10662);
    });
  });

  describe('spreadsheet values', () => {
    it('reads a named-sheet range with native cell types', async () => {
      const read = await fetchApi(
        `/open-apis/sheets/v2/spreadsheets/adv-sheet/values/Data!A1:C3`,
      );
      const envelope = (await read.json()) as {
        code: number;
        data: { valueRange: { range: string; values: (string | number | null)[][] } };
      };
      expect(envelope.code).toBe(0);
      expect(envelope.data.valueRange.range).toBe('Data!A1:C3');
      expect(envelope.data.valueRange.values).toEqual([
        ['Region', 'Q1', 'Q2'],
        ['APAC', 10, 20],
        ['EMEA', 5, 15],
      ]);
    });

    it('reads a bare range against the first sheet', async () => {
      const read = await fetchApi(`/open-apis/sheets/v2/spreadsheets/adv-sheet/values/B2:C3`);
      const envelope = (await read.json()) as {
        code: number;
        data: { valueRange: { values: (string | number | null)[][] } };
      };
      expect(envelope.code).toBe(0);
      expect(envelope.data.valueRange.values).toEqual([
        [10, 20],
        [5, 15],
      ]);
    });

    it('writes a range and returns the updated cell count', async () => {
      const write = await fetchApi('/open-apis/sheets/v2/spreadsheets/adv-sheet/values', {
        method: 'PUT',
        body: JSON.stringify({
          valueRange: { range: 'Data!C3', values: [[30]] },
        }),
      });
      const envelope = (await write.json()) as {
        code: number;
        data: { spreadsheetToken: string; updatedRange: string; updatedCells: number };
      };
      expect(envelope.code).toBe(0);
      expect(envelope.data.spreadsheetToken).toBe('adv-sheet');
      expect(envelope.data.updatedCells).toBe(1);

      const read = (await (
        await fetchApi(`/open-apis/sheets/v2/spreadsheets/adv-sheet/values/Data!C3`)
      ).json()) as { code: number; data: { valueRange: { values: (string | number | null)[][] } } };
      expect(read.data.valueRange.values).toEqual([[30]]);
    });

    it('rejects values whose shape does not match the range with 10002', async () => {
      const write = await fetchApi('/open-apis/sheets/v2/spreadsheets/adv-sheet/values', {
        method: 'PUT',
        body: JSON.stringify({
          valueRange: { range: 'Data!A1:B2', values: [[1]] },
        }),
      });
      const envelope = (await write.json()) as { code: number; msg: string };
      expect(envelope.code).toBe(10002);
      expect(envelope.msg).toContain('does not match range');
    });

    it('rejects an unknown spreadsheet or sheet name with 10662', async () => {
      const missingSpreadsheet = (await (
        await fetchApi(`/open-apis/sheets/v2/spreadsheets/nope/values/Data!A1`)
      ).json()) as { code: number };
      expect(missingSpreadsheet.code).toBe(10662);

      const missingSheet = (await (
        await fetchApi(`/open-apis/sheets/v2/spreadsheets/adv-sheet/values/Nope!A1`)
      ).json()) as { code: number };
      expect(missingSheet.code).toBe(10662);
    });

    it('applies scripted failures and auth to sheet endpoints', async () => {
      mock.failNextDocs({ code: 99991672, msg: 'invalid access token' });
      const read = await fetchApi(`/open-apis/sheets/v2/spreadsheets/adv-sheet/values/Data!A1`);
      const envelope = (await read.json()) as { code: number };
      expect(envelope.code).toBe(99991672);
    });
  });

  describe('Bitable apps and records', () => {
    /** Resolves a seeded table's id through the tables endpoint. */
    async function tableId(name: string): Promise<string> {
      const listed = (await (
        await fetchApi(`/open-apis/bitable/v1/apps/adv-bit/tables`)
      ).json()) as {
        code: number;
        data: { items: Array<{ table_id: string; name: string }> };
      };
      const table = listed.data.items.find((t) => t.name === name);
      if (!table) throw new Error(`seeded table "${name}" not found`);
      return table.table_id;
    }

    it('lists tables of an app', async () => {
      const listed = (await (
        await fetchApi(`/open-apis/bitable/v1/apps/adv-bit/tables`)
      ).json()) as {
        code: number;
        data: { items: Array<{ table_id: string; name: string }> };
      };
      expect(listed.code).toBe(0);
      expect(listed.data.items.map((t) => t.name)).toEqual(['Leads', 'Archive']);
      expect(listed.data.items[0]?.table_id).toBeTruthy();
    });

    it('reads records with field-name-based values, respecting page_size', async () => {
      const read = (await (
        await fetchApi(`/open-apis/bitable/v1/apps/adv-bit/tables/${await tableId('Leads')}/records?page_size=1`)
      ).json()) as {
        code: number;
        data: { items: Array<{ record_id: string; fields: Record<string, unknown> }>; has_more: boolean };
      };
      expect(read.code).toBe(0);
      expect(read.data.items).toHaveLength(1);
      expect(read.data.items[0]?.fields).toEqual({ name: 'Ada', stage: 'qualified' });
      expect(read.data.has_more).toBe(false);
    });

    it('creates a record and returns its id, visible on the next read', async () => {
      const created = (await (
        await fetchApi(`/open-apis/bitable/v1/apps/adv-bit/tables/${await tableId('Leads')}/records`, {
          method: 'POST',
          body: JSON.stringify({ fields: { name: 'Katherine', stage: 'new' } }),
        })
      ).json()) as {
        code: number;
        data: { record: { record_id: string; fields: Record<string, unknown> } };
      };
      expect(created.code).toBe(0);
      expect(created.data.record.record_id).toBeTruthy();
      expect(created.data.record.fields).toEqual({ name: 'Katherine', stage: 'new' });

      const read = (await (
        await fetchApi(`/open-apis/bitable/v1/apps/adv-bit/tables/${await tableId('Leads')}/records`)
      ).json()) as { code: number; data: { items: Array<{ record_id: string }> } };
      expect(read.data.items.map((r) => r.record_id)).toContain(created.data.record.record_id);
    });

    it('rejects an unknown app or table with 10662', async () => {
      const missingApp = (await (
        await fetchApi(`/open-apis/bitable/v1/apps/nope/tables`)
      ).json()) as { code: number };
      expect(missingApp.code).toBe(10662);

      const missingTable = (await (
        await fetchApi(`/open-apis/bitable/v1/apps/adv-bit/tables/tbl_nope/records`)
      ).json()) as { code: number };
      expect(missingTable.code).toBe(10662);
    });
  });
});
