import { decryptValue } from '../src/feishu/crypto.js';
import pg from 'pg';

const APP_KEY = process.env.APP_KEY!;
const APP_SECRET = process.env.APP_SECRET!;
const TENANT_ID = process.env.TENANT_ID!;
const CONNECTION_ID = process.env.CONNECTION_ID!;
const DENTRY_UUID = process.env.DENTRY_UUID!;
const DOC_KEY = process.env.DOC_KEY!;

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
const q = (p: string) => `https://api.dingtalk.com${p}?operatorId=${encodeURIComponent(unionId)}`;
const probe = async (label: string, url: string) => {
  const r = await fetch(url, { headers: { 'x-acs-dingtalk-access-token': appToken } });
  const text = await r.text();
  console.log(`${label}: ${r.status} ${text.slice(0, 700)}`);
};

// blocks on the doc we created + appended content to (DOC_KEY = 4maOg...)
await probe('A blocks(docKey)', q(`/v1.0/doc/suites/documents/${DOC_KEY}/blocks`));
// blocks on the renamed doc (dentryUuid)
await probe('B blocks(dentryUuid)', q(`/v1.0/doc/suites/documents/${DENTRY_UUID}/blocks`));
// export again (Document.Document.Read still missing?)
await probe('C export', q('/v2.0/doc/dentries/export'), {
  method: 'POST', headers: { 'x-acs-dingtalk-access-token': appToken, 'content-type': 'application/json' },
  body: JSON.stringify({ param: { dentryUuid: DENTRY_UUID, exportType: 'dingTalkDocToDocx' } }),
});
