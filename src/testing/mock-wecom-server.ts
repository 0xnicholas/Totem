import { Hono } from 'hono';
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { randomUUID } from 'node:crypto';
import { isRecord } from '../admin/util.js';

interface ScriptedFailure {
  errcode?: number;
  httpStatus?: ContentfulStatusCode;
  message: string;
}

export interface MockWeComServerOptions {
  corpId: string;
  secret: string;
  /**
   * The self-built app's agentid (#47). When set, message/send only
   * accepts a matching agentid (mismatch → errcode 42009, the documented
   * token/agentid mismatch); unset means any numeric agentid is accepted.
   */
  agentId?: string;
  /** Access token lifetime issued to clients, in seconds (WeCom's documented default: 7200). */
  accessTokenTtlSeconds?: number;
}

/** A seeded member the app's visibility covers (#47): the email→userid universe. */
export interface MockWeComMember {
  userid: string;
  /** The member's 企业邮箱 (get_userid_by_email email_type 1). */
  corpEmail?: string;
  /** The member's 个人邮箱 (get_userid_by_email email_type 2). */
  personalEmail?: string;
}

/** A seeded group chat — by the appchat contract, one the app created itself. */
export interface MockWeComChat {
  chatId: string;
}

/** A robot-sent group message the mock recorded (#47). */
export interface RecordedUserMessage {
  touser: string;
  agentId: number;
  msgtype: string;
  content: string;
}

/** An app-sent chat message the mock recorded (#47). */
export interface RecordedChatMessage {
  chatid: string;
  msgtype: string;
  content: string;
}

/** One email→userid lookup the mock served (#47), with the email_type namespace probed. */
export interface RecordedUseridLookup {
  email: string;
  emailType: number;
}

/**
 * Seam B (#48, ADR-0017; messaging surface #47): an in-memory mock of the
 * WeCom (企业微信) self-built-app API surface the platform talks to — the
 * gettoken endpoint behind the cached token cell, plus the messaging trio
 * `send_message` maps onto (#47): user/get_userid_by_email,
 * message/send, appchat/send.
 *
 * WeCom's envelope convention (tracked by the kernel's WeCom profile):
 * HTTP is (almost) always 200 and `errcode !== 0` is the failure signal —
 * unlike Feishu's `code`, the field is `errcode`/`errmsg`, and invalid
 * corpid/secret is a 40001 over HTTP 200. Business APIs authenticate with
 * `?access_token=` (query param), which the kernel profile models via
 * `tokenQueryName` (#48).
 *
 * Error codes are the documented ones (global error-code list + the
 * message/send partial-failure rules): 60111 userid not found, 81013 all
 * recipients invalid, 86003 chatid not exists, 45009 api freq limit,
 * 40014 invalid token. The mock records every accepted message so tests
 * pin the connector's request shapes.
 */
export class MockWeComServer {
  readonly app: Hono;
  /** Number of gettoken calls received. */
  gettokenRequestCount = 0;
  /** Messages accepted through message/send (touser path), in order. */
  readonly sentUserMessages: RecordedUserMessage[] = [];
  /** Messages accepted through appchat/send (chatid path), in order. */
  readonly sentChatMessages: RecordedChatMessage[] = [];
  /** Every email→userid lookup served, with the email_type namespace probed. */
  readonly useridLookups: RecordedUseridLookup[] = [];

  private readonly accessTokenTtlSeconds: number;
  private readonly issuedAccessTokens = new Map<string, { expiresAt: number }>();
  private readonly members: MockWeComMember[] = [];
  private readonly chats: MockWeComChat[] = [];
  private scriptedFailure: ScriptedFailure | undefined;

  constructor(private readonly options: MockWeComServerOptions) {
    this.accessTokenTtlSeconds = options.accessTokenTtlSeconds ?? 7200;
    this.app = new Hono();

    // GET /cgi-bin/gettoken — client credentials for self-built apps. The
    // credentials ARE the query params; the response is an errcode envelope.
    this.app.get('/cgi-bin/gettoken', (c) => {
      const scripted = this.scriptedResponse();
      if (scripted) return scripted;
      this.gettokenRequestCount++;
      const corpid = c.req.query('corpid');
      const corpsecret = c.req.query('corpsecret');
      if (corpid !== options.corpId || corpsecret !== options.secret) {
        // WeCom convention: HTTP 200 + errcode 40001 (invalid credentials).
        return c.json({ errcode: 40001, errmsg: 'invalid corpid or corpsecret' }, 200);
      }
      const accessToken = `wc_access_${randomUUID()}`;
      this.issuedAccessTokens.set(accessToken, {
        expiresAt: Date.now() + this.accessTokenTtlSeconds * 1000,
      });
      return c.json({
        errcode: 0,
        errmsg: 'ok',
        access_token: accessToken,
        expires_in: this.accessTokenTtlSeconds,
      });
    });

    // POST /cgi-bin/user/get_userid_by_email (#47, official-docs shape):
    // body {email, email_type} (1 = 企业邮箱, 2 = 个人邮箱) → {userid}.
    // A miss is errcode 60111 (UserID不存在) over HTTP 200; the app must
    // have member visibility to resolve at all.
    this.app.post('/cgi-bin/user/get_userid_by_email', async (c) => {
      const scripted = this.scriptedResponse();
      if (scripted) return scripted;
      const auth = this.requireToken(c);
      if (auth) return auth;
      const body = readJsonBody(await c.req.text());
      const email = body.email;
      const emailType = body.email_type;
      if (typeof email !== 'string' || (emailType !== 1 && emailType !== 2)) {
        return c.json({ errcode: 60129, errmsg: 'member email and email_type are required' }, 200);
      }
      this.useridLookups.push({ email, emailType });
      const member = this.members.find(
        emailType === 1
          ? (candidate) => candidate.corpEmail === email
          : (candidate) => candidate.personalEmail === email,
      );
      if (!member) {
        return c.json({ errcode: 60111, errmsg: 'userid not found' }, 200);
      }
      return c.json({ errcode: 0, errmsg: 'ok', userid: member.userid });
    });

    // POST /cgi-bin/message/send (#47, official-docs shape): body {touser,
    // msgtype, agentid (整型), text:{content}} → {msgid}; msgtype markdown
    // (#59) carries markdown:{content} instead. A single invalid recipient
    // is the all-recipients-invalid case: errcode 81013 over HTTP 200 (the
    // documented full-failure code).
    this.app.post('/cgi-bin/message/send', async (c) => {
      const scripted = this.scriptedResponse();
      if (scripted) return scripted;
      const auth = this.requireToken(c);
      if (auth) return auth;
      const body = readJsonBody(await c.req.text());
      const touser = body.touser;
      const msgtype = body.msgtype;
      const agentid = body.agentid;
      const content = readMessageContent(body);
      if (typeof touser !== 'string' || typeof msgtype !== 'string' || typeof agentid !== 'number' || typeof content !== 'string') {
        return c.json({ errcode: 40058, errmsg: 'touser, msgtype, agentid and text.content/markdown.content are required' }, 200);
      }
      if (this.options.agentId !== undefined && agentid !== Number(this.options.agentId)) {
        // Documented mismatch: the token belongs to a different app.
        return c.json({ errcode: 42009, errmsg: 'access_token and agentid mismatch' }, 200);
      }
      if (!this.members.some((member) => member.userid === touser)) {
        return c.json({ errcode: 81013, errmsg: 'all recipients are invalid' }, 200);
      }
      const msgid = `wcmsg_${randomUUID()}`;
      this.sentUserMessages.push({ touser, agentId: agentid, msgtype, content });
      return c.json({ errcode: 0, errmsg: 'ok', msgid });
    });

    // POST /cgi-bin/appchat/send (#47, official-docs shape): body {chatid,
    // msgtype, text:{content}} → {msgid}; msgtype markdown (#59) carries
    // markdown:{content} instead. The chat must be one the app created (the
    // mock's seeded universe) — an unknown chatid is errcode 86003 (参数
    // chatid 不存在) over HTTP 200. NOTE: the documented envelope is
    // errcode/errmsg only; the msgid mirrors the current live behavior
    // (SDK-observed) the connector's live pass will pin — tests script the
    // msgid-less shape separately.
    this.app.post('/cgi-bin/appchat/send', async (c) => {
      const scripted = this.scriptedResponse();
      if (scripted) return scripted;
      const auth = this.requireToken(c);
      if (auth) return auth;
      const body = readJsonBody(await c.req.text());
      const chatid = body.chatid;
      const msgtype = body.msgtype;
      const content = readMessageContent(body);
      if (typeof chatid !== 'string' || typeof msgtype !== 'string' || typeof content !== 'string') {
        return c.json({ errcode: 40058, errmsg: 'chatid, msgtype and text.content/markdown.content are required' }, 200);
      }
      if (!this.chats.some((chat) => chat.chatId === chatid)) {
        return c.json({ errcode: 86003, errmsg: 'chatid not exists' }, 200);
      }
      const msgid = `wcchat_${randomUUID()}`;
      this.sentChatMessages.push({ chatid, msgtype, content });
      return c.json({ errcode: 0, errmsg: 'ok', msgid });
    });
  }

  /** True when the presented token is one this mock issued and it is unexpired. */
  isTokenValid(token: string | undefined): boolean {
    const record = token ? this.issuedAccessTokens.get(token) : undefined;
    return record !== undefined && Date.now() <= record.expiresAt;
  }

  /** Seeds the members the app can address by email (#47). */
  seedMembers(members: MockWeComMember[]): void {
    this.members.push(...members);
  }

  /** Seeds the group chats — the app-created universe appchat/send reaches (#47). */
  seedChats(chats: MockWeComChat[]): void {
    this.chats.push(...chats);
  }

  /** Scripts one failure for the next API call (any endpoint, errcode envelope). */
  failNext(failure: ScriptedFailure): void {
    this.scriptedFailure = failure;
  }

  /** Consumes the scripted failure, if any, into a WeCom error envelope. */
  private scriptedResponse(): Response | undefined {
    const scripted = this.scriptedFailure;
    if (!scripted) return undefined;
    this.scriptedFailure = undefined;
    const body: Record<string, unknown> = { errmsg: scripted.message };
    if (scripted.errcode !== undefined) body.errcode = scripted.errcode;
    return new Response(JSON.stringify(body), {
      status: scripted.httpStatus ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  }

  /**
   * The business-endpoint auth check: WeCom authenticates by query param,
   * and a bad token is errcode 40014 over HTTP 200 (never an HTTP status).
   */
  private requireToken(c: Context): Response | undefined {
    if (this.isTokenValid(c.req.query('access_token'))) return undefined;
    return new Response(JSON.stringify({ errcode: 40014, errmsg: 'invalid access token' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }
}

/** Parses a JSON object body defensively (mock-internal: no throw on garbage). */
function readJsonBody(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Reads the message content from the msgtype's own body field (#59):
 * `markdown: {content}` for msgtype markdown, `text: {content}` otherwise.
 */
function readMessageContent(body: Record<string, unknown>): string | undefined {
  const field = body.msgtype === 'markdown' ? body.markdown : body.text;
  return isRecord(field) && typeof field.content === 'string' ? field.content : undefined;
}
