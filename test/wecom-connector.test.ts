import { serve, type ServerType } from '@hono/node-server';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CONNECTION_ACTIONS,
  MESSAGING_ACTIONS,
  createActionExecutor,
} from '../src/index.js';
import { WeComConnector } from '../src/wecom/connector.js';
import { createWeComOAuthClient } from '../src/wecom/oauth.js';
import {
  InMemoryAllowlistStore,
  InMemoryAuditSink,
} from '../src/testing/memory-governance.js';
import { MockWeComServer } from '../src/testing/mock-wecom-server.js';

const CORP_ID = 'conn_ww_corp';
const SECRET = 'conn_ww_secret';
const AGENT_ID = '1000002';
const TENANT = 'tenant-wecom';
const CONNECTION = 'conn-wecom';

/**
 * The WeCom messaging connector (#47, third ADR-0016 batch — Seam B): the
 * canonical `send_message` over a WeCom self-built app (自建应用), with
 * `test_connection` as the token-acquisition proof (ADR-0017 — no harmless
 * send probe exists). Tested against the mock WeCom API, no real
 * credentials; plus a Seam A slice proving the action executes through
 * the execution boundary with the same governance as any connector.
 */
describe('WeComConnector (Seam B)', () => {
  let server: ServerType;
  let baseUrl: string;
  let mock: MockWeComServer;
  let connector: WeComConnector;
  let appToken: string;

  beforeAll(async () => {
    mock = new MockWeComServer({ corpId: CORP_ID, secret: SECRET, agentId: AGENT_ID });
    server = serve({ fetch: mock.app.fetch, port: 0 });
    await new Promise((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    connector = new WeComConnector(baseUrl, {
      // The connection's identity (agentid), as the composition root would
      // resolve it from the tenant's registered credentials.
      getAgentId: () => Promise.resolve(AGENT_ID),
    });

    // A real app token from the mock's gettoken endpoint, as the cached
    // cell (ADR-0017) would deliver it in ActionContext.
    const oauth = createWeComOAuthClient({ apiBaseUrl: baseUrl });
    appToken = (
      await oauth.appAccessToken({ creds: { corpId: CORP_ID, secret: SECRET, agentId: AGENT_ID } })
    ).accessToken;

    mock.seedMembers([
      { userid: 'zhangsan', corpEmail: 'zhangsan@corp.example' },
      { userid: 'lisi', personalEmail: 'lisi@personal.example' },
      { userid: 'wangwu', corpEmail: 'wangwu@corp.example', personalEmail: 'wangwu@personal.example' },
    ]);
    mock.seedChats([{ chatId: 'chat-1' }]);
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  function ctx() {
    return { tenantId: TENANT, connectionId: CONNECTION, token: appToken };
  }

  it('declares the wecom_messaging manifest: both paths, conservative 60/min', () => {
    expect(connector.manifest).toMatchObject({
      id: 'wecom_messaging',
      provider: 'wecom',
      implements: ['test_connection', 'send_message', 'recall_message'],
      rateLimit: { requestsPerMinute: 60 },
    });
  });

  it('test_connection is the token-acquisition proof: ok with no upstream call (ADR-0017)', async () => {
    // The boundary acquires the app token (gettoken via the cached cell)
    // BEFORE dispatch — reaching the handler already proves the creds.
    // There is no harmless send probe on WeCom, so the handler itself
    // calls nothing.
    const tokenCalls = mock.gettokenRequestCount;
    const lookupsBefore = mock.useridLookups.length;
    const sentBefore = mock.sentUserMessages.length + mock.sentChatMessages.length;
    const output = (await connector.execute('test_connection', {}, ctx())) as {
      connection_id: string;
      status: string;
    };
    expect(output).toEqual({ connection_id: CONNECTION, status: 'ok' });
    expect(mock.gettokenRequestCount).toBe(tokenCalls);
    expect(mock.useridLookups).toHaveLength(lookupsBefore);
    expect(mock.sentUserMessages.length + mock.sentChatMessages.length).toBe(sentBefore);
  });

  it('send_message resolves a corp email to a userid and sends as the app (touser path)', async () => {
    const output = (await connector.execute(
      'send_message',
      { email: 'zhangsan@corp.example', content: 'deploy done' },
      ctx(),
    )) as { message_id: string };
    expect(output.message_id).toMatch(/^wcmsg_/);
    // The request shapes the canonical mapping pins: get_userid_by_email
    // (corp namespace first, email_type 1) then message/send with
    // touser, msgtype text, and the INTEGER agentid — the app identity.
    expect(mock.useridLookups).toEqual([
      { email: 'zhangsan@corp.example', emailType: 1 },
    ]);
    expect(mock.sentUserMessages).toEqual([
      { touser: 'zhangsan', agentId: Number(AGENT_ID), msgtype: 'text', content: 'deploy done' },
    ]);
  });

  it('send_message probes the personal-email namespace when the corp namespace misses', async () => {
    const output = (await connector.execute(
      'send_message',
      { email: 'lisi@personal.example', content: 'hi' },
      ctx(),
    )) as { message_id: string };
    expect(output.message_id).toMatch(/^wcmsg_/);
    // WeCom's email→userid lookup has two namespaces (1 = 企业邮箱,
    // 2 = 个人邮箱); the canonical email is namespace-free, so the
    // connector probes corp first, then personal — one miss is not a
    // not_found, only a combined miss is.
    expect(mock.useridLookups.slice(-2)).toEqual([
      { email: 'lisi@personal.example', emailType: 1 },
      { email: 'lisi@personal.example', emailType: 2 },
    ]);
    expect(mock.sentUserMessages.at(-1)).toMatchObject({ touser: 'lisi', content: 'hi' });
  });

  it('send_message maps an unknown email (both namespaces miss) to not_found, nothing sent', async () => {
    const sentBefore = mock.sentUserMessages.length;
    await expect(
      connector.execute('send_message', { email: 'nobody@corp.example', content: 'x' }, ctx()),
    ).rejects.toMatchObject({ code: 'not_found', retryable: false });
    expect(mock.sentUserMessages).toHaveLength(sentBefore);
  });

  it('send_message maps an unknown touser (81013, all recipients invalid) to not_found', async () => {
    // The userid resolved but is invisible to the app — the documented
    // full-failure code for message/send.
    mock.seedMembers([{ userid: 'ghost' }]);
    await expect(
      connector.execute('send_message', { email: 'ghost@corp.example', content: 'x' }, ctx()),
    ).rejects.toMatchObject({ code: 'not_found', retryable: false });
  });

  it('send_message sends to an app-created chat via appchat/send and returns the message id', async () => {
    const output = (await connector.execute(
      'send_message',
      { chat_id: 'chat-1', content: 'build green' },
      ctx(),
    )) as { message_id: string };
    expect(output.message_id).toMatch(/^wcchat_/);
    expect(mock.sentChatMessages).toEqual([
      { chatid: 'chat-1', msgtype: 'text', content: 'build green' },
    ]);
  });

  it('send_message maps an unknown chatid (86003) to not_found', async () => {
    await expect(
      connector.execute('send_message', { chat_id: 'chat-none', content: 'x' }, ctx()),
    ).rejects.toMatchObject({ code: 'not_found', retryable: false });
  });

  it('send_message with format=markdown sends msgtype markdown on the user path (#59)', async () => {
    const output = (await connector.execute(
      'send_message',
      { email: 'zhangsan@corp.example', content: '# deploy **done**', format: 'markdown' },
      ctx(),
    )) as { message_id: string };
    expect(output.message_id).toMatch(/^wcmsg_/);
    // The markdown branch: msgtype flips and the content rides the
    // markdown body field — passed through verbatim, no platform-side
    // parsing (pure translator, ADR-0003).
    expect(mock.sentUserMessages.at(-1)).toEqual({
      touser: 'zhangsan',
      agentId: Number(AGENT_ID),
      msgtype: 'markdown',
      content: '# deploy **done**',
    });
  });

  it('send_message with format=markdown sends msgtype markdown on the chat path (#59)', async () => {
    const output = (await connector.execute(
      'send_message',
      { chat_id: 'chat-1', content: '## build *green*', format: 'markdown' },
      ctx(),
    )) as { message_id: string };
    expect(output.message_id).toMatch(/^wcchat_/);
    // appchat/send supports markdown too (official docs) — same verbatim
    // pass-through as the user path.
    expect(mock.sentChatMessages.at(-1)).toEqual({
      chatid: 'chat-1',
      msgtype: 'markdown',
      content: '## build *green*',
    });
  });

  it('send_message with explicit format=text stays on the text msgtype (#59 regression)', async () => {
    const output = (await connector.execute(
      'send_message',
      { chat_id: 'chat-1', content: 'plain as ever', format: 'text' },
      ctx(),
    )) as { message_id: string };
    expect(output.message_id).toMatch(/^wcchat_/);
    // Explicit text = the absent-format default: byte-identical to the
    // pre-#59 request shape.
    expect(mock.sentChatMessages.at(-1)).toEqual({
      chatid: 'chat-1',
      msgtype: 'text',
      content: 'plain as ever',
    });
  });

  it('send_message maps a frequency-limit errcode (45009) to rate_limited (retryable)', async () => {
    mock.failNext({ errcode: 45009, message: 'api freq out of limit' });
    await expect(
      connector.execute('send_message', { chat_id: 'chat-1', content: 'x' }, ctx()),
    ).rejects.toMatchObject({ code: 'rate_limited', retryable: true });
  });

  it('send_message maps a mid-call token rejection to upstream_error (operator creds), never auth_expired', async () => {
    // ADR-0017: a credential connection has no user grant to expire — a
    // rejected app token is an operator-credential problem (rotated
    // secret, wrong corpid), surfaced as upstream_error so the agent is
    // never told to re-authorize.
    mock.failNext({ errcode: 42001, message: 'access token expired' });
    await expect(
      connector.execute('send_message', { chat_id: 'chat-1', content: 'x' }, ctx()),
    ).rejects.toMatchObject({
      code: 'upstream_error',
      retryable: false,
      message: /credential|wecom-creds/i,
    });
  });

  it('send_message preserves an unmatched errcode (42009 token/agentid mismatch) in upstream', async () => {
    mock.failNext({ errcode: 42009, message: 'access_token and agentid mismatch' });
    await expect(
      connector.execute('send_message', { chat_id: 'chat-1', content: 'x' }, ctx()),
    ).rejects.toMatchObject({
      code: 'upstream_error',
      upstream: { code: '42009' },
    });
  });

  it('send_message fails loudly when no agentid is resolvable for the tenant', async () => {
    // The email path carries the app identity (agentid); a tenant without
    // credentials resolved cannot send to a user.
    const bare = new WeComConnector(baseUrl);
    await expect(
      bare.execute('send_message', { email: 'zhangsan@corp.example', content: 'x' }, ctx()),
    ).rejects.toMatchObject({ code: 'upstream_error', message: /wecom-creds/ });

    const unset = new WeComConnector(baseUrl, {
      getAgentId: () => Promise.resolve(undefined),
    });
    const sentBefore = mock.sentUserMessages.length;
    await expect(
      unset.execute('send_message', { email: 'zhangsan@corp.example', content: 'x' }, ctx()),
    ).rejects.toMatchObject({ code: 'upstream_error', message: /wecom-creds/ });
    expect(mock.sentUserMessages).toHaveLength(sentBefore);
  });

  it('send_message rejects a non-numeric agentid as an operator-config problem', async () => {
    const weird = new WeComConnector(baseUrl, {
      getAgentId: () => Promise.resolve('not-a-number'),
    });
    await expect(
      weird.execute('send_message', { email: 'zhangsan@corp.example', content: 'x' }, ctx()),
    ).rejects.toMatchObject({ code: 'upstream_error', message: /agentid/i });
  });

  it('send_message surfaces a msgid-less appchat success honestly: sent, but no id returned', async () => {
    // The documented appchat/send envelope is errcode/errmsg only; the
    // live API returns msgid (SDK-observed) — the live pass will pin it.
    // If msgid is ever absent, the message WAS sent: the error says so,
    // so the agent never blind-retries a duplicate.
    mock.failNext({ errcode: 0, message: 'ok' });
    // failNext errcode 0 passes the envelope check but omits msgid.
    await expect(
      connector.execute('send_message', { chat_id: 'chat-1', content: 'once' }, ctx()),
    ).rejects.toMatchObject({
      code: 'upstream_error',
      message: /was sent|no message id/i,
    });
  });

  it('maps a network failure to upstream_error', async () => {
    const dead = new WeComConnector('http://127.0.0.1:1', {
      getAgentId: () => Promise.resolve(AGENT_ID),
    });
    await expect(
      dead.execute('test_connection', {}, { tenantId: TENANT, connectionId: CONNECTION }),
    ).resolves.toEqual({ connection_id: CONNECTION, status: 'ok' });
    // test_connection never goes upstream; the send path does.
    await expect(
      dead.execute('send_message', { chat_id: 'chat-1', content: 'x' }, ctx()),
    ).rejects.toMatchObject({ code: 'upstream_error' });
  });

  it('recall_message recalls a sent message by the message_id send_message returned (#60)', async () => {
    const sent = (await connector.execute(
      'send_message',
      { email: 'zhangsan@corp.example', content: 'wrong recipient' },
      ctx(),
    )) as { message_id: string };

    const output = await connector.execute(
      'recall_message',
      { message_id: sent.message_id },
      ctx(),
    );
    // Bare ack: success IS the output, no content curated from upstream.
    expect(output).toEqual({});
    // The upstream saw exactly the msgid its own message/send issued.
    expect(mock.recalledMsgIds).toEqual([sent.message_id]);
  });

  it('recall_message recalls a chat message too (the connector attempts any message_id)', async () => {
    const sent = (await connector.execute(
      'send_message',
      { chat_id: 'chat-1', content: 'premature send' },
      ctx(),
    )) as { message_id: string };
    const output = await connector.execute(
      'recall_message',
      { message_id: sent.message_id },
      ctx(),
    );
    expect(output).toEqual({});
    expect(mock.recalledMsgIds.at(-1)).toBe(sent.message_id);
  });

  it('recall_message maps an unknown message_id (40058) to not_found (#60)', async () => {
    // "Never existed" — distinguishable from the window closing.
    const recalledBefore = mock.recalledMsgIds.length;
    await expect(
      connector.execute('recall_message', { message_id: 'wcmsg_never_existed' }, ctx()),
    ).rejects.toMatchObject({ code: 'not_found', retryable: false });
    expect(mock.recalledMsgIds).toHaveLength(recalledBefore);
  });

  it('recall_message maps a closed recall window (42052) to a non-retryable upstream_error that says so (#60)', async () => {
    const sent = (await connector.execute(
      'send_message',
      { chat_id: 'chat-1', content: 'old news' },
      ctx(),
    )) as { message_id: string };
    mock.expireMsgId(sent.message_id);
    const recalledBefore = mock.recalledMsgIds.length;

    // The window is upstream policy: the error must say it closed so the
    // agent stops retrying and reports honestly instead of blind-retrying.
    await expect(
      connector.execute('recall_message', { message_id: sent.message_id }, ctx()),
    ).rejects.toMatchObject({
      code: 'upstream_error',
      retryable: false,
      message: /window has closed|24 hours/i,
      upstream: { code: '42052' },
    });
    expect(mock.recalledMsgIds).toHaveLength(recalledBefore);
  });

  it('recall_message keeps the token-rejection mapping unchanged (operator creds, never auth_expired)', async () => {
    mock.failNext({ errcode: 42001, message: 'access token expired' });
    await expect(
      connector.execute('recall_message', { message_id: 'wcmsg_any' }, ctx()),
    ).rejects.toMatchObject({
      code: 'upstream_error',
      retryable: false,
      message: /credential|wecom-creds/i,
    });
  });
});

/** Seam A slice: the same governance as any connector, through the boundary. */
describe('WeComConnector (Seam A slice)', () => {
  let server: ServerType;
  let baseUrl: string;
  let mock: MockWeComServer;
  let appToken: string;

  beforeAll(async () => {
    mock = new MockWeComServer({ corpId: CORP_ID, secret: SECRET, agentId: AGENT_ID });
    server = serve({ fetch: mock.app.fetch, port: 0 });
    await new Promise((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const oauth = createWeComOAuthClient({ apiBaseUrl: baseUrl });
    appToken = (
      await oauth.appAccessToken({ creds: { corpId: CORP_ID, secret: SECRET, agentId: AGENT_ID } })
    ).accessToken;
    mock.seedMembers([{ userid: 'zhangsan', corpEmail: 'zhangsan@corp.example' }]);
    mock.seedChats([{ chatId: 'chat-1' }]);
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  function makeExecutor(opts: { allowed: string[] }) {
    const allowlists = new InMemoryAllowlistStore();
    allowlists.setAllowed(TENANT, CONNECTION, opts.allowed);
    const audit = new InMemoryAuditSink();
    const executor = createActionExecutor({
      actions: [...MESSAGING_ACTIONS, ...CONNECTION_ACTIONS],
      connectors: [
        new WeComConnector(baseUrl, { getAgentId: () => Promise.resolve(AGENT_ID) }),
      ],
      connections: [{ tenantId: TENANT, connectionId: CONNECTION, connectorId: 'wecom_messaging' }],
      allowlists,
      audit,
      // The boundary-side stand-in for the cached gettoken cell (ADR-0017):
      // acquisition happens here, before dispatch — which is exactly why
      // test_connection is the token-acquisition proof.
      tokenProvider: { getValidAccessToken: () => Promise.resolve(appToken) },
    });
    return { executor, audit };
  }

  it('executes send_message when allowed, audited like any action', async () => {
    const { executor, audit } = makeExecutor({ allowed: ['send_message'] });
    const result = await executor.executeAction(
      TENANT,
      CONNECTION,
      'send_message',
      { chat_id: 'chat-1', content: 'e2e hello' },
      'rpc',
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      const sent = result.output as { message_id: string };
      expect(sent.message_id).toMatch(/^wcchat_/);
    }
    expect(audit.list()).toHaveLength(1);
    expect(audit.list()[0]).toMatchObject({
      tenantId: TENANT,
      connectionId: CONNECTION,
      actionName: 'send_message',
      source: 'rpc',
      success: true,
    });
  });

  it('rejects send_message when the allowlist does not include it (fail-closed)', async () => {
    const { executor } = makeExecutor({ allowed: [] });
    const result = await executor.executeAction(
      TENANT,
      CONNECTION,
      'send_message',
      { chat_id: 'chat-1', content: 'x' },
      'rpc',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('forbidden');
  });

  it('fails token acquisition as test_connection\'s proof: a dead gettoken fails the action before the handler', async () => {
    // ADR-0017: gettoken failing = creds invalid = the action fails at
    // the boundary with the acquisition error — test_connection has no
    // handler-side probe to mask or duplicate that signal.
    const allowlists = new InMemoryAllowlistStore();
    allowlists.setAllowed(TENANT, CONNECTION, ['test_connection']);
    const audit = new InMemoryAuditSink();
    const executor = createActionExecutor({
      actions: [...MESSAGING_ACTIONS, ...CONNECTION_ACTIONS],
      connectors: [
        new WeComConnector(baseUrl, { getAgentId: () => Promise.resolve(AGENT_ID) }),
      ],
      connections: [{ tenantId: TENANT, connectionId: CONNECTION, connectorId: 'wecom_messaging' }],
      allowlists,
      audit,
      tokenProvider: {
        getValidAccessToken: () =>
          Promise.reject(new Error('WeCom gettoken failed (errcode 40001)')),
      },
    });
    const result = await executor.executeAction(TENANT, CONNECTION, 'test_connection', {}, 'cli');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('upstream_error');
      expect(result.error.message).toContain('Token acquisition failed');
    }
    expect(audit.list()[0]).toMatchObject({ success: false, errorCode: 'upstream_error' });
  });

  it('rejects explicit-null addressing at the boundary (validation_error, #56)', async () => {
    const { executor, audit } = makeExecutor({ allowed: ['send_message'] });
    const sentBefore = mock.sentChatMessages.length;
    const result = await executor.executeAction(
      TENANT,
      CONNECTION,
      'send_message',
      { email: null, content: 'x' },
      'rpc',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('validation_error');
    expect(mock.sentChatMessages).toHaveLength(sentBefore);
    expect(audit.list()[0]).toMatchObject({ errorCode: 'validation_error' });
  });

  it('recall_message flows through the destructive path: forbidden without the acknowledged allowlist entry (#60, ADR-0018)', async () => {
    // Replace semantics: an allowlist that omits recall_message is the
    // unacknowledged case — the destructive class is default-deny.
    const { executor } = makeExecutor({ allowed: ['send_message'] });
    const result = await executor.executeAction(
      TENANT,
      CONNECTION,
      'recall_message',
      { message_id: 'wcmsg_any' },
      'rpc',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('forbidden');
    expect(mock.recalledMsgIds).toHaveLength(0);
  });

  it('recall_message executes when allowlisted and lands a stamped audit row (#60, ADR-0018)', async () => {
    const { executor, audit } = makeExecutor({ allowed: ['send_message', 'recall_message'] });
    const sent = await executor.executeAction(
      TENANT,
      CONNECTION,
      'send_message',
      { chat_id: 'chat-1', content: 'recall me' },
      'rpc',
    );
    expect(sent.ok).toBe(true);
    if (!sent.ok) return;
    const messageId = (sent.output as { message_id: string }).message_id;

    const result = await executor.executeAction(
      TENANT,
      CONNECTION,
      'recall_message',
      { message_id: messageId },
      'rpc',
    );
    // Bare ack through the boundary too.
    expect(result).toMatchObject({ ok: true, output: {} });
    expect(mock.recalledMsgIds).toEqual([messageId]);

    // Every destructive attempt is audited with the effects stamp.
    const row = audit.list().at(-1);
    expect(row).toMatchObject({
      tenantId: TENANT,
      connectionId: CONNECTION,
      actionName: 'recall_message',
      source: 'rpc',
      success: true,
    });
    expect(row?.metadata).toMatchObject({ effects: 'destructive' });
  });
});
