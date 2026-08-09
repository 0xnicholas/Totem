import { serve, type ServerType } from '@hono/node-server';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFeishuOAuthClient } from '../src/feishu/oauth.js';
import { MockFeishuServer } from '../src/testing/mock-feishu-server.js';

const APP_ID = 'docs_app_id';
const APP_SECRET = 'docs_app_secret';
const REDIRECT_URI = 'https://totem.example.com/oauth/callback/feishu';

/**
 * Seam B docs contract (T7): the mock's Feishu Docs endpoints — drive
 * search, docx raw_content, drive metas — plus token enforcement and
 * scripted failures. Pinned here so the connector (and T8-T9) can rely on
 * the shapes without re-deriving them.
 */
describe('MockFeishuServer docs endpoints', () => {
  let server: ServerType;
  let baseUrl: string;
  let mock: MockFeishuServer;
  let accessToken: string;

  beforeAll(async () => {
    mock = new MockFeishuServer({ appId: APP_ID, appSecret: APP_SECRET });
    mock.seedDocs([
      {
        doc_id: 'doc-aaa',
        title: 'Q3 Planning',
        content: '# Q3 Planning\n\nShip the action layer.',
        owner_id: 'user-1',
        doc_type: 'docx',
        edited_at: '2026-03-01T10:00:00.000Z',
      },
      {
        doc_id: 'doc-bbb',
        title: 'Q4 Retro',
        content: 'What went well, what did not.',
        owner_id: 'user-2',
        doc_type: 'docx',
        edited_at: '2026-02-01T10:00:00.000Z',
      },
      {
        doc_id: 'doc-ccc',
        title: 'Budget Sheet',
        content: 'numbers',
        owner_id: 'user-1',
        doc_type: 'sheet',
        edited_at: '2026-01-15T10:00:00.000Z',
      },
    ]);
    server = serve({ fetch: mock.app.fetch, port: 0 });
    await new Promise((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    // An issued access token, as a real OAuth flow would produce.
    const oauth = createFeishuOAuthClient(baseUrl);
    const pair = await oauth.exchangeCode({
      creds: { appId: APP_ID, appSecret: APP_SECRET },
      code: await mock.authorizeCode(REDIRECT_URI, 'st-docs'),
      redirectUri: REDIRECT_URI,
    });
    accessToken = pair.accessToken;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  function docsHeaders(): Record<string, string> {
    return { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' };
  }

  it('searches files by title substring, newest first, honoring page_size', async () => {
    const res = await fetch(
      `${baseUrl}/open-apis/drive/v1/files/search?page_size=10`,
      {
        method: 'POST',
        headers: docsHeaders(),
        body: JSON.stringify({ search_key: 'q' }),
      },
    );
    const envelope = (await res.json()) as {
      code: number;
      data: { files: Array<{ token: string; name: string; type: string }> };
    };
    expect(envelope.code).toBe(0);
    expect(envelope.data.files.map((f) => [f.token, f.name, f.type])).toEqual([
      ['doc-aaa', 'Q3 Planning', 'docx'],
      ['doc-bbb', 'Q4 Retro', 'docx'],
    ]);
  });

  it('returns an empty file list for a non-matching query', async () => {
    const res = await fetch(`${baseUrl}/open-apis/drive/v1/files/search`, {
      method: 'POST',
      headers: docsHeaders(),
      body: JSON.stringify({ search_key: 'zzz-no-match' }),
    });
    const envelope = (await res.json()) as { code: number; data: { files: unknown[] } };
    expect(envelope.code).toBe(0);
    expect(envelope.data.files).toEqual([]);
  });

  it('returns raw content for a document and 10662 for an unknown one', async () => {
    const ok = await fetch(`${baseUrl}/open-apis/docx/v1/documents/doc-aaa/raw_content`, {
      headers: docsHeaders(),
    });
    const envelope = (await ok.json()) as { code: number; data: { content: string } };
    expect(envelope.code).toBe(0);
    expect(envelope.data.content).toContain('Q3 Planning');

    const missing = await fetch(`${baseUrl}/open-apis/docx/v1/documents/doc-nope/raw_content`, {
      headers: docsHeaders(),
    });
    expect(((await missing.json()) as { code: number }).code).toBe(10662);
  });

  it('returns metadata (title, owner, type, edit time) via metas batch_query', async () => {
    const res = await fetch(`${baseUrl}/open-apis/drive/v1/metas/batch_query`, {
      method: 'POST',
      headers: docsHeaders(),
      body: JSON.stringify({ request_docs: [{ doc_token: 'doc-ccc', doc_type: 'sheet' }] }),
    });
    const envelope = (await res.json()) as {
      code: number;
      data: {
        metas: Array<{
          doc_token: string;
          doc_type: string;
          title: string;
          owner_id: string;
          modified_time: string;
        }>;
      };
    };
    expect(envelope.code).toBe(0);
    expect(envelope.data.metas).toEqual([
      {
        doc_token: 'doc-ccc',
        doc_type: 'sheet',
        title: 'Budget Sheet',
        owner_id: 'user-1',
        modified_time: '2026-01-15T10:00:00.000Z',
      },
    ]);
  });

  it('rejects docs calls without a valid issued access token (99991672)', async () => {
    const res = await fetch(`${baseUrl}/open-apis/drive/v1/files/search`, {
      method: 'POST',
      headers: { authorization: 'Bearer not-an-issued-token', 'content-type': 'application/json' },
      body: JSON.stringify({ search_key: 'q' }),
    });
    expect(((await res.json()) as { code: number }).code).toBe(99991672);
  });

  it('scripts a failure for the next docs call (permission denied, then 429)', async () => {
    mock.failNextDocs({ code: 91672, msg: 'permission denied' });
    const denied = await fetch(`${baseUrl}/open-apis/docx/v1/documents/doc-aaa/raw_content`, {
      headers: docsHeaders(),
    });
    expect(((await denied.json()) as { code: number }).code).toBe(91672);

    mock.failNextDocs({ code: 99991400, msg: 'rate limit', httpStatus: 429 });
    const limited = await fetch(`${baseUrl}/open-apis/docx/v1/documents/doc-aaa/raw_content`, {
      headers: docsHeaders(),
    });
    expect(limited.status).toBe(429);
    expect(((await limited.json()) as { code: number }).code).toBe(99991400);
  });
});
