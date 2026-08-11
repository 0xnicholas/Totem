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
  const text = await r.text();
  let extra = '';
  try {
    const b = JSON.parse(text) as { accessdenieddetail?: { requiredScopes?: string[] }; message?: string };
    if (b.accessdenieddetail?.requiredScopes) extra = ` requiredScopes=${JSON.stringify(b.accessdenieddetail.requiredScopes)}`;
    else if (r.status !== 200) extra = ` msg=${b.message ?? ''}`;
  } catch { /* non-json */ }
  console.log(`${label}: ${r.status} ${text.slice(0, 140)}${extra}`);
};

const q = (p: string) => `https://api.dingtalk.com${p}?operatorId=${encodeURIComponent(unionId)}`;
const mine = await fetch(q('/v2.0/wiki/mineWorkspaces'), { headers: { 'x-acs-dingtalk-access-token': appToken } });
const spaceId = ((await mine.json()) as { workspace?: { workspaceId?: string } }).workspace?.workspaceId;

for (const [who, token] of [['APP', appToken], ['USER', userToken]] as const) {
  console.log(`--- ${who} token ---`);
  await probe(`search`, token, q('/v2.0/storage/dentries/search'), {
    method: 'POST', headers: { 'x-acs-dingtalk-access-token': token, 'content-type': 'application/json' },
    body: JSON.stringify({ keyword: 'probe', option: { maxResults: 5 } }),
  });
  await probe(`create`, token, q(`/v2.0/doc/spaces/${spaceId}/dentries`), {
    method: 'POST', headers: { 'x-acs-dingtalk-access-token': token, 'content-type': 'application/json' },
    body: JSON.stringify({ dentryType: 'file', documentType: 0, name: `retest-${who}-${Date.now()}`, operatorId: unionId }),
  });
  await probe(`getNode`, token, q(`/v2.0/wiki/nodes/${DENTRY_UUID}`));
  await probe(`insert`, token, q(`/v1.0/doc/suites/documents/${DENTRY_UUID}/content`), {
    method: 'POST', headers: { 'x-acs-dingtalk-access-token': token, 'content-type': 'application/json' },
    body: JSON.stringify({ content: { content: 'retest', type: 'markdown' } }),
  });
  await probe(`content dentries/`, token, q(`/v2.0/doc/dentries/${DENTRY_UUID}/contents`));
  await probe(`content query/`, token, q(`/v2.0/doc/query/${DENTRY_UUID}/contents`));
  await probe(`content me/query/`, token, q(`/v2.0/doc/me/query/${DENTRY_UUID}/contents`));
  await probe(`export`, token, q('/v2.0/doc/dentries/export'), {
    method: 'POST', headers: { 'x-acs-dingtalk-access-token': token, 'content-type': 'application/json' },
    body: JSON.stringify({ param: { dentryUuid: DENTRY_UUID, exportType: 'dingTalkDocToDocx' } }),
  });
}
