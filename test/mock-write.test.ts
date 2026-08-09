import { serve, type ServerType } from '@hono/node-server';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFeishuOAuthClient } from '../src/feishu/oauth.js';
import { MockFeishuServer } from '../src/testing/mock-feishu-server.js';

const APP_ID = 'w_app_id';
const APP_SECRET = 'w_app_secret';
const REDIRECT_URI = 'https://totem.example.com/oauth/callback/feishu';

/**
 * Seam B write contract (T8): docx create, the blocks API (list + append
 * children) used by append_doc_content, the title PATCH used by
 * rename_doc, the drive move endpoint, and the doc-lock failure mode.
 */
describe('MockFeishuServer write endpoints', () => {
  let server: ServerType;
  let baseUrl: string;
  let mock: MockFeishuServer;
  let accessToken: string;
  let docId: string;

  beforeAll(async () => {
    mock = new MockFeishuServer({ appId: APP_ID, appSecret: APP_SECRET });
    mock.seedDocs([
      {
        doc_id: 'w-doc',
        title: 'Write Target',
        content: 'First line.',
        owner_id: 'user-1',
        doc_type: 'docx',
        edited_at: '2026-03-01T10:00:00.000Z',
      },
    ]);
    server = serve({ fetch: mock.app.fetch, port: 0 });
    await new Promise((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const oauth = createFeishuOAuthClient(baseUrl);
    const pair = await oauth.exchangeCode({
      creds: { appId: APP_ID, appSecret: APP_SECRET },
      code: await mock.authorizeCode(REDIRECT_URI, 'st-w'),
      redirectUri: REDIRECT_URI,
    });
    accessToken = pair.accessToken;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  function jsonFetch(path: string, init: RequestInit = {}): Promise<Response> {
    return fetch(`${baseUrl}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
        ...init.headers,
      },
    });
  }

  it('creates a document (title, optional folder) and returns id + url', async () => {
    const res = await jsonFetch('/open-apis/docx/v1/documents', {
      method: 'POST',
      body: JSON.stringify({ title: 'Created Doc', folder_token: 'folder-1' }),
    });
    const envelope = (await res.json()) as {
      code: number;
      data: { document: { document_id: string; title: string; url: string } };
    };
    expect(envelope.code).toBe(0);
    expect(envelope.data.document.title).toBe('Created Doc');
    expect(envelope.data.document.document_id).toBeTruthy();
    expect(envelope.data.document.url).toContain(envelope.data.document.document_id);
    docId = envelope.data.document.document_id;
  });

  it('lists the document root block for append targeting', async () => {
    const res = await jsonFetch(`/open-apis/docx/v1/documents/${docId}/blocks`);
    const envelope = (await res.json()) as {
      code: number;
      data: { items: Array<{ block_id: string; block_type: number; parent_id: string | null }> };
    };
    expect(envelope.code).toBe(0);
    const root = envelope.data.items.find((b) => b.parent_id === null);
    expect(root?.block_id).toBeTruthy();
  });

  it('appends a text block as a child of the root and updates content', async () => {
    const root = await jsonFetch(`/open-apis/docx/v1/documents/${docId}/blocks`);
    const items = ((await root.json()) as { data: { items: Array<{ block_id: string; parent_id: string | null }> } }).data.items;
    const rootId = items.find((b) => b.parent_id === null)!.block_id;

    const res = await jsonFetch(
      `/open-apis/docx/v1/documents/${docId}/blocks/${rootId}/children`,
      {
        method: 'POST',
        body: JSON.stringify({
          children: [{ block_type: 2, text: { elements: [{ text_run: { content: 'Appended line.' } }] } }],
        }),
      },
    );
    expect(((await res.json()) as { code: number }).code).toBe(0);

    // The append is reflected in raw_content (updated state).
    const content = await jsonFetch(`/open-apis/docx/v1/documents/${docId}/raw_content`);
    const envelope = (await content.json()) as { data: { content: string } };
    expect(envelope.data.content).toContain('Appended line.');
  });

  it('renames a document via the title PATCH', async () => {
    const res = await jsonFetch(`/open-apis/docx/v1/documents/${docId}`, {
      method: 'PATCH',
      body: JSON.stringify({ title: 'Renamed Doc' }),
    });
    const envelope = (await res.json()) as { code: number; data: { document: { title: string } } };
    expect(envelope.code).toBe(0);
    expect(envelope.data.document.title).toBe('Renamed Doc');
  });

  it('moves a document to a folder', async () => {
    const res = await jsonFetch(`/open-apis/drive/v1/files/${docId}/move`, {
      method: 'POST',
      body: JSON.stringify({ folder_token: 'folder-2' }),
    });
    const envelope = (await res.json()) as { code: number; data: { task_id: string } };
    expect(envelope.code).toBe(0);
    expect(envelope.data.task_id).toBeTruthy();
  });

  it('rejects writes to a locked document with 10667', async () => {
    mock.lockDoc('w-doc');
    const renamed = await jsonFetch(`/open-apis/docx/v1/documents/w-doc`, {
      method: 'PATCH',
      body: JSON.stringify({ title: 'Nope' }),
    });
    expect(((await renamed.json()) as { code: number }).code).toBe(10667);
    mock.unlockDoc('w-doc');
  });

  it('rejects writes to unknown documents with 10662', async () => {
    const moved = await jsonFetch(`/open-apis/drive/v1/files/doc-nope/move`, {
      method: 'POST',
      body: JSON.stringify({ folder_token: 'folder-2' }),
    });
    expect(((await moved.json()) as { code: number }).code).toBe(10662);
  });
});
