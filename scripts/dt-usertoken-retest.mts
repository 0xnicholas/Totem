import { decryptValue } from '../src/feishu/crypto.js';
import pg from 'pg';

const APP_KEY = process.env.APP_KEY!;
const APP_SECRET = process.env.APP_SECRET!;
const TENANT_ID = process.env.TENANT_ID!;
const CONNECTION_ID = process.env.CONNECTION_ID!;

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const row = (await pool.query<{ user_access_token: string }>(
  'SELECT user_access_token FROM tokens WHERE connection_id = $1', [CONNECTION_ID],
)).rows[0];
await pool.end();
const userToken = decryptValue(TENANT_ID, row!.user_access_token, process.env.TOTEM_TOKEN_ENC_KEY!);
const me = await fetch('https://api.dingtalk.com/v1.0/contact/users/me', {
  headers: { 'x-acs-dingtalk-access-token': userToken },
});
const unionId = ((await me.json()) as { unionId?: string }).unionId ?? '';
const H = { 'x-acs-dingtalk-access-token': userToken } as Record<string, string>;
const probe = async (label: string, url: string, init?: RequestInit) => {
  const r = await fetch(url, init ?? { headers: H });
  const text = await r.text();
  console.log(`${label}: ${r.status} ${text.slice(0, 400)}`);
  return r.status;
};

// 1. search with USER token
await probe('1 search (USER)', 'https://api.dingtalk.com/v2.0/storage/dentries/search?operatorId=' + encodeURIComponent(unionId), {
  method: 'POST', headers: { ...H, 'content-type': 'application/json' },
  body: JSON.stringify({ keyword: 'probe', option: { maxResults: 5 } }),
});
// 2. create with USER token
const mine = await fetch('https://api.dingtalk.com/v2.0/wiki/mineWorkspaces?operatorId=' + encodeURIComponent(unionId), { headers: H });
const spaceId = ((await mine.json()) as { workspace?: { workspaceId?: string } }).workspace?.workspaceId;
const st = await probe('2 create (USER)', `https://api.dingtalk.com/v2.0/doc/spaces/${spaceId}/dentries`, {
  method: 'POST', headers: { ...H, 'content-type': 'application/json' },
  body: JSON.stringify({ dentryType: 'file', documentType: 0, name: 'usertok-' + Date.now(), operatorId: unionId }),
});
// 3. getNode with USER token
await probe('3 getNode (USER)', `https://api.dingtalk.com/v2.0/wiki/nodes/${'Exel2BLV5pP3eRmwiPAa3eL0Wgk9rpMq'}?operatorId=${encodeURIComponent(unionId)}`);
// 4. rename with USER token
await probe('4 rename (USER)', `https://api.dingtalk.com/v2.0/doc/spaces/${spaceId}/dentries/Exel2BLV5pP3eRmwiPAa3eL0Wgk9rpMq/rename`, {
  method: 'POST', headers: { ...H, 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'usertok-renamed-' + Date.now(), operatorId: unionId }),
});
// 5. full requiredScopes of the content-read 403s (user token)
for (const p of [`/v2.0/doc/dentries/Exel2BLV5pP3eRmwiPAa3eL0Wgk9rpMq/contents`, `/v2.0/doc/me/query/Exel2BLV5pP3eRmwiPAa3eL0Wgk9rpMq/contents`]) {
  const r = await fetch(`https://api.dingtalk.com${p}?operatorId=${encodeURIComponent(unionId)}`, { headers: H });
  const b = (await r.json()) as { accessdenieddetail?: { requiredScopes?: string[] } };
  console.log(`5 ${p}: ${r.status} requiredScopes=${JSON.stringify(b.accessdenieddetail?.requiredScopes)}`);
}
