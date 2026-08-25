/**
 * Live WeCom verification driver (#57; covers the provisional items of the
 * #47 send batch, #59 markdown, #60 recall, and #61 mentions). Operator
 * tooling: run against a real self-built app whose visibility is the root
 * department (the appchat requirement), with a test member and an
 * app-created group.
 *
 * There is no authorize flow on WeCom (ADR-0017 credential connection):
 * registering the credentials IS the connection creation, so the script
 * goes straight from wecom-creds to the action surface.
 *
 * Usage:
 *   WECOM_CORP_ID=... WECOM_SECRET=... WECOM_AGENT_ID=... \
 *   LIVE_MEMBER_EMAIL=<test member email> LIVE_CHAT_ID=<app-created chatid> \
 *   npx tsx scripts/live-wecom-pass.mts [--burst <n>]
 *
 * Env: ADMIN_BASE (default http://localhost:3200), TOTEM_ADMIN_KEY,
 * TENANT_NAME (default 'live-wecom-pass').
 * --burst <n>: send n rapid chat messages to observe rate-limit behavior
 * (member caps are silently dropped upstream — this checks no error
 * surfaces; skipped by default, it spams the group).
 *
 * Checklist (#57 + later batches):
 *   1. appchat/send msgid presence on the success envelope (HIGHEST —
 *      SDK-observed, undocumented; absence flips every chat send to
 *      ok:false despite delivery).
 *   2. message/send msgid (documented) + 60111 two-namespace email probe.
 *   3. errcode sets live: 60111, 86003 (unknown chatid), 40058 (unknown
 *      recall msgid); token/freq families are environment-dependent.
 *   4. recall: user-path msgid (documented 24h window), chat-path msgid
 *      (UNDOCUMENTED — pins whether appchat messages are recallable),
 *      unknown msgid → not_found.
 *   5. markdown on both paths (#59); mentions on the chat path (#61).
 */
import { AdminApiClient } from '../src/admin/client.js';

const CORP_ID = process.env.WECOM_CORP_ID!;
const SECRET = process.env.WECOM_SECRET!;
const AGENT_ID = process.env.WECOM_AGENT_ID!;
const MEMBER_EMAIL = process.env.LIVE_MEMBER_EMAIL;
const CHAT_ID = process.env.LIVE_CHAT_ID;
const ADMIN_BASE = process.env.ADMIN_BASE ?? 'http://localhost:3200';
const ADMIN_KEY = process.env.TOTEM_ADMIN_KEY!;
const TENANT_NAME = process.env.TENANT_NAME ?? 'live-wecom-pass';
const BURST = process.argv.includes('--burst')
  ? Number(process.argv[process.argv.indexOf('--burst') + 1])
  : 0;

const FINDINGS: string[] = [];
const log = (msg: string) => console.log(`[live] ${msg}`);
const finding = (msg: string) => {
  FINDINGS.push(msg);
  console.log(`[finding] ${msg}`);
};

const admin = new AdminApiClient({ baseUrl: ADMIN_BASE, apiKey: ADMIN_KEY });

async function rpc(
  connectionId: string,
  key: string,
  action: string,
  args: Record<string, unknown>,
): Promise<{ ok: boolean; output?: unknown; error?: { code: string; message: string } }> {
  const res = await fetch(`${ADMIN_BASE}/actions/rpc`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${key}`,
      'x-connection-id': connectionId,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ action, args }),
  });
  const body = (await res.json()) as {
    ok?: boolean;
    output?: unknown;
    error?: { code: string; message: string };
  };
  return { ok: res.status === 200 && body.ok !== false, ...body };
}

/** Sends and reports, returning the message_id on success. */
async function send(
  connectionId: string,
  key: string,
  label: string,
  args: Record<string, unknown>,
): Promise<string | undefined> {
  const result = await rpc(connectionId, key, 'send_message', args);
  log(`${label}: ${JSON.stringify(result.output ?? result.error)}`);
  if (!result.ok) {
    finding(`${label} FAILED: ${result.error?.code} ${result.error?.message}`);
    return undefined;
  }
  const messageId = (result.output as { message_id: string }).message_id;
  finding(`${label} OK: message_id=${messageId}`);
  return messageId;
}

async function main() {
  if (!CORP_ID || !SECRET || !AGENT_ID) {
    throw new Error('WECOM_CORP_ID / WECOM_SECRET / WECOM_AGENT_ID env required');
  }
  if (!ADMIN_KEY) throw new Error('TOTEM_ADMIN_KEY env required');

  log('creating tenant');
  const tenant = await admin.createTenant(TENANT_NAME);
  log(`tenant ${tenant.id} (${tenant.name})`);

  log('registering wecom credentials (this IS the connection creation, ADR-0017)');
  const { connectionId } = await admin.setWecomCreds(tenant.id, CORP_ID, SECRET, AGENT_ID);
  log(`connection ${connectionId}`);

  const key = (await admin.createKey(tenant.id, 'actions')).key;
  // recall_message is destructive class (ADR-0018): the allowlist needs the
  // explicit acknowledgement.
  await admin.setAllowlist(connectionId, ['test_connection', 'send_message', 'recall_message'], {
    allowDestructive: true,
  });

  // --- connection ---
  const tc = await rpc(connectionId, key, 'test_connection', {});
  log(`test_connection: ${JSON.stringify(tc)}`);
  if (!tc.ok) finding(`test_connection FAILED: ${tc.error?.code} ${tc.error?.message}`);

  // --- user path (#47 item 2, #59) ---
  if (MEMBER_EMAIL) {
    const userMsgId = await send(connectionId, key, 'user text', {
      email: MEMBER_EMAIL,
      content: `totem live pass (user text) ${new Date().toISOString()}`,
    });
    await send(connectionId, key, 'user markdown', {
      email: MEMBER_EMAIL,
      content: '**totem** live pass (user markdown)',
      format: 'markdown',
    });

    // recall the just-sent user message (#60, documented 24h window)
    if (userMsgId) {
      const recall = await rpc(connectionId, key, 'recall_message', { message_id: userMsgId });
      log(`recall user message: ${JSON.stringify(recall.output ?? recall.error)}`);
      if (!recall.ok) finding(`recall user-path FAILED: ${recall.error?.code} ${recall.error?.message}`);
      else finding('recall user-path OK (documented behavior confirmed)');
    }

    // 60111: unknown email must surface not_found after the two-namespace probe
    const miss = await rpc(connectionId, key, 'send_message', {
      email: `definitely-not-a-member-${Date.now()}@invalid.example`,
      content: 'x',
    });
    finding(
      miss.ok
        ? 'unknown email UNEXPECTEDLY sent — check the 60111 mapping'
        : `unknown email: code=${miss.error?.code} (expect not_found) — ${miss.error?.message}`,
    );

    // #61: mentions on the user path must reject with validation_error
    const userMentions = await rpc(connectionId, key, 'send_message', {
      email: MEMBER_EMAIL,
      content: 'x',
      mentions: [MEMBER_EMAIL],
    });
    finding(
      !userMentions.ok && userMentions.error?.code === 'validation_error'
        ? 'user-path mentions rejected with validation_error (as specified, #61)'
        : `user-path mentions UNEXPECTED: ${JSON.stringify(userMentions.output ?? userMentions.error)}`,
    );
  } else {
    finding('LIVE_MEMBER_EMAIL unset — user path, recall-window, and email-probe checks skipped');
  }

  // --- chat path (#57 item 1, HIGHEST; #59; #61) ---
  if (CHAT_ID) {
    // The connector fails honestly when appchat/send omits msgid — so a
    // successful RPC here IS the msgid-presence pin; a failure with
    // "returned no msgid" is the documented-envelope finding.
    const chatMsgId = await send(connectionId, key, 'chat text', {
      chat_id: CHAT_ID,
      content: `totem live pass (chat text) ${new Date().toISOString()}`,
    });
    await send(connectionId, key, 'chat markdown', {
      chat_id: CHAT_ID,
      content: '**totem** live pass (chat markdown)',
      format: 'markdown',
    });

    if (MEMBER_EMAIL) {
      await send(connectionId, key, 'chat text with mentions', {
        chat_id: CHAT_ID,
        content: 'totem live pass (mentions)',
        mentions: [MEMBER_EMAIL],
      });
      await send(connectionId, key, 'chat markdown with mentions', {
        chat_id: CHAT_ID,
        content: '**totem** live pass (markdown mentions)',
        format: 'markdown',
        mentions: [MEMBER_EMAIL],
      });
      // '@all' on text is documented; one run pins the sentinel end-to-end
      await send(connectionId, key, 'chat text @all', {
        chat_id: CHAT_ID,
        content: 'totem live pass (@all)',
        mentions: ['@all'],
      });
      // #61: one unresolvable mention email must fail the whole send
      const atomic = await rpc(connectionId, key, 'send_message', {
        chat_id: CHAT_ID,
        content: 'x',
        mentions: [MEMBER_EMAIL, `ghost-${Date.now()}@invalid.example`],
      });
      finding(
        !atomic.ok && atomic.error?.code === 'not_found'
          ? 'atomic mentions: one miss failed the whole send with not_found (as specified, #61)'
          : `atomic mentions UNEXPECTED: ${JSON.stringify(atomic.output ?? atomic.error)}`,
      );
    }

    // #60: appchat-msgid recallability is UNDOCUMENTED — this pins it
    if (chatMsgId) {
      const recall = await rpc(connectionId, key, 'recall_message', { message_id: chatMsgId });
      finding(
        recall.ok
          ? 'recall CHAT-path msgid OK — appchat messages ARE recallable (undocumented upstream, now live-pinned)'
          : `recall chat-path msgid FAILED: ${recall.error?.code} ${recall.error?.message} — appchat recallability pinned as unsupported`,
      );
    }

    // 86003: unknown chatid must surface not_found
    const noChat = await rpc(connectionId, key, 'send_message', {
      chat_id: 'totem-no-such-chat',
      content: 'x',
    });
    finding(
      !noChat.ok && noChat.error?.code === 'not_found'
        ? `unknown chatid: not_found as mapped (${noChat.error?.message})`
        : `unknown chatid UNEXPECTED: ${JSON.stringify(noChat.output ?? noChat.error)}`,
    );

    // 40058: unknown recall msgid must surface not_found
    const noMsg = await rpc(connectionId, key, 'recall_message', { message_id: 'wcmsg_never_existed' });
    finding(
      !noMsg.ok && noMsg.error?.code === 'not_found'
        ? 'unknown recall msgid: not_found as mapped (40058)'
        : `unknown recall msgid UNEXPECTED: ${JSON.stringify(noMsg.output ?? noMsg.error)}`,
    );

    // --- rate-limit observation (#57 item 4, opt-in) ---
    if (BURST > 0) {
      log(`burst: sending ${BURST} rapid chat messages (member caps drop SILENTLY upstream — watching for surfaced errors)`);
      let okCount = 0;
      const started = Date.now();
      for (let i = 0; i < BURST; i++) {
        const r = await rpc(connectionId, key, 'send_message', {
          chat_id: CHAT_ID,
          content: `burst ${i + 1}/${BURST}`,
        });
        if (r.ok) okCount++;
        else finding(`burst message ${i + 1} FAILED: ${r.error?.code} ${r.error?.message}`);
      }
      finding(
        `burst: ${okCount}/${BURST} accepted in ${Date.now() - started}ms — ` +
          'verify in the group how many actually ARRIVED (silent drops never error); ' +
          'decide whether the conservative 60/min declaration stays',
      );
    } else {
      log('burst skipped (pass --burst <n> to exercise rate-limit behavior)');
    }
  } else {
    finding('LIVE_CHAT_ID unset — chat path, msgid pin, chat recall, and errcode checks skipped');
  }

  console.log('\n===== FINDINGS =====');
  for (const f of FINDINGS) console.log(`- ${f}`);
}

main().catch((err) => {
  console.error('[live] fatal:', err);
  process.exitCode = 1;
});
