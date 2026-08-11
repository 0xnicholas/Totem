import { decryptValue } from '../src/feishu/crypto.js';
import pg from 'pg';

const APP_KEY = process.env.APP_KEY!;
const APP_SECRET = process.env.APP_SECRET!;
const TENANT_ID = process.env.TENANT_ID!;
const CONNECTION_ID = process.env.CONNECTION_ID!;
const DENTRY_UUID = process.env.DENTRY_UUID!;

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
const tokenRes = await fetch('https://api.dingtalk.com/v1.0/oauth2/accessToken', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ appKey: APP_KEY, appSecret: APP_SECRET }),
});
const appToken = ((await tokenRes.json()) as { accessToken?: string }).accessToken!;
const probe = async (label: string, token: string, url: string, init?: RequestInit) => {
  const r = await fetch(url, init ?? { headers: { 'x-acs-dingtalk-access-token': token } });
  let body: unknown;
  try { body = await r.json(); } catch { body = '(non-json)'; }
  console.log(`${label}: ${r.status} ${JSON.stringify(body).slice(0, 260)}`);
};

// DocContent with the USER token (delegated-permission variant?)
await probe('A dentries/contents (USER token)', userToken,
  `https://api.dingtalk.com/v2.0/doc/dentries/${DENTRY_UUID}/contents?operatorId=${encodeURIComponent(unionId)}`);
// GetDocContent with the USER token
await probe('B me/query/contents (USER token)', userToken,
  `https://api.dingtalk.com/v2.0/doc/me/query/${DENTRY_UUID}/contents?operatorId=${encodeURIComponent(unionId)}`);
// insert content with USER token (delegated?) — earlier insert worked with app token; try user
await probe('C insert content (USER token)', userToken,
  `https://api.dingtalk.com/v1.0/doc/suites/documents/${DENTRY_UUID}/content?operatorId=${encodeURIComponent(unionId)}`,
  { method: 'POST', headers: { 'x-acs-dingtalk-access-token': userToken, 'content-type': 'application/json' },
    body: JSON.stringify({ content: { content: 'user-token-probe', type: 'markdown' } }) });
// export create (app token) — which permission?
await probe('D export create (APP token)', appToken,
  'https://api.dingtalk.com/v2.0/doc/dentries/export',
  { method: 'POST', headers: { 'x-acs-dingtalk-access-token': appToken, 'content-type': 'application/json' },
    body: JSON.stringify({ param: { dentryUuid: DENTRY_UUID, exportType: 'dingTalkDocToDocx' } }) });
