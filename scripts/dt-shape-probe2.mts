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
const q = (path: string) => path + (path.includes('?') ? '&' : '?') + 'operatorId=' + encodeURIComponent(unionId);
const H = { 'x-acs-dingtalk-access-token': appToken } as Record<string, string>;
const probe = async (label: string, url: string, init?: RequestInit) => {
  const r = await fetch(url, init ?? { headers: H });
  let body: unknown;
  try { body = await r.json(); } catch { body = '(non-json)'; }
  const b = body as { code?: string; message?: string };
  console.log(`${label}: ${r.status} ${JSON.stringify(body).slice(0, 260)}`);
  return body;
};

const nodeBody = (await probe('1 getNode', q(`https://api.dingtalk.com/v2.0/wiki/nodes/${DENTRY_UUID}`))) as {
  node?: { workspaceId?: string };
};
const spaceId = nodeBody.node?.workspaceId;
console.log('   (spaceId=' + spaceId + ')');

for (const p of [
  `/v2.0/doc/dentries/${DENTRY_UUID}/contents`,
  `/v2.0/doc/query/${DENTRY_UUID}/contents`,
  `/v2.0/doc/me/query/${DENTRY_UUID}/contents`,
]) {
  await probe(`2 ${p}`, q(`https://api.dingtalk.com${p}`));
}

if (spaceId) {
  await probe('3 rename', `https://api.dingtalk.com/v2.0/doc/spaces/${spaceId}/dentries/${DENTRY_UUID}/rename`, {
    method: 'POST', headers: { ...H, 'content-type': 'application/json' },
    body: JSON.stringify({ name: `renamed-${Date.now()}`, operatorId: unionId }),
  });
}
