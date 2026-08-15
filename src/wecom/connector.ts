import type { ActionContext, ActionHandler } from '../action.js';
import type {
  SendMessageInput,
  SendMessageOutput,
  TestConnectionOutput,
} from '../actions.js';
import type { IConnector } from '../connector.js';
import { ActionError } from '../errors.js';
import { WECOM_CONNECTOR_ID } from './creds-store.js';
import { createWeComHttp, WeComApiError } from './oauth.js';
import type { UpstreamHttp } from '../upstream-http.js';

/**
 * WeCom errcode families (#47, pinned against the official global
 * error-code list and the message/send partial-failure rules):
 * - 60111 userid 不存在 (also get_userid_by_email's miss);
 * - 81013 message/send's ALL-recipients-invalid code — with the canonical
 *   single-recipient mapping, an invisible/unknown touser fails wholly;
 * - 40050 chatid 不存在, 86001/86003 参数 chatid 不合法/不存在, and
 *   86008 非法操作非自己创建的群 — the appchat universe is app-created
 *   groups only, so every one of these is "the chat you named cannot be
 *   reached".
 * Provisional-until-live-pass in the DingTalk-messaging sense: the mapping
 * contract is what is pinned; a live pass may grow the sets.
 */
const NOT_FOUND_CODES = new Set([60111, 81013, 40050, 86001, 86003, 86008]);

/** 45009 接口调用超过限制, 45033 接口并发调用超过限制. */
const RATE_LIMIT_CODES = new Set([45009, 45033]);

/**
 * 40014 invalid / 41001 missing / 42001 expired access token, 42009
 * token-agentid mismatch. Never `auth_expired`: ADR-0017 — a credential
 * connection has no user grant to expire, so a rejected app token is an
 * operator-credential problem (rotated secret, wrong corpid/agentid), the
 * same reclassification the DingTalk connector applies to app-token
 * rejections.
 */
const TOKEN_REJECTED_CODES = new Set([40014, 41001, 42001, 42009]);

/** get_userid_by_email's documented miss code. */
const USERID_NOT_FOUND = 60111;

/**
 * Maps a WeCom API failure into the unified error vocabulary (ADR-0005).
 * The connector owns `not_found` (unknown user/chat), `rate_limited`
 * (frequency/concurrency errcodes), and `upstream_error` with the original
 * errcode preserved in `upstream` for diagnostics. `auth_expired` is
 * deliberately absent — see TOKEN_REJECTED_CODES.
 */
export function mapWeComError(err: WeComApiError): ActionError {
  if (RATE_LIMIT_CODES.has(err.errcode)) {
    return new ActionError('rate_limited', `WeCom rate limited: ${err.message}`);
  }
  if (TOKEN_REJECTED_CODES.has(err.errcode)) {
    return new ActionError(
      'upstream_error',
      `WeCom rejected the app access token (errcode ${err.errcode}) — an operator-credential ` +
        'problem (rotated secret or wrong corpid/agentid), not a re-authorizable grant; ' +
        `re-register the credentials via the wecom-creds admin endpoint: ${err.message}`,
      { upstream: { code: String(err.errcode), message: err.message } },
    );
  }
  if (NOT_FOUND_CODES.has(err.errcode)) {
    return new ActionError('not_found', `WeCom recipient not found: ${err.message}`, {
      upstream: { code: String(err.errcode), message: err.message },
    });
  }
  return new ActionError(
    'upstream_error',
    `WeCom API error (errcode ${err.errcode}): ${err.message}`,
    { upstream: { code: String(err.errcode), message: err.message } },
  );
}

/**
 * The WeCom messaging connector (#47, third ADR-0016 batch): the canonical
 * `send_message` over a WeCom self-built app (自建应用), plus
 * `test_connection`. A pure translator per ADR-0003 — unified args → WeCom
 * request, WeCom response → unified output, WeCom's errcode envelope → the
 * unified vocabulary.
 *
 * Identity (ADR-0016 amendment, ADR-0017): every message is sent with the
 * APP identity — `message/send` requires the app's agentid and there is no
 * user-grant token on WeCom. The agentid is resolved per tenant by the
 * composition root from the registered credentials (the same shape as the
 * DingTalk connector's robotCode bit); a tenant without credentials
 * resolved fails loudly with the operator action.
 *
 * Canonical mapping (issue #47):
 * - `email` → `POST /cgi-bin/user/get_userid_by_email` `{email, email_type}`
 *   → userid → `POST /cgi-bin/message/send` `{touser, msgtype: "text",
 *   agentid, text}`. WeCom's lookup has two email namespaces (email_type
 *   1 = 企业邮箱, 2 = 个人邮箱) while the canonical email carries none, so
 *   the connector probes corp first, then personal — only a combined miss
 *   is `not_found`. Requires the app to hold member-visibility permission
 *   (upstream surfaces the lack as an errcode, mapped like any other).
 * - `chat_id` → `POST /cgi-bin/appchat/send` `{chatid, msgtype: "text",
 *   text}` — and ONLY groups the app created itself (appchat/create):
 *   arbitrary org group chats are unreachable (errcode 86008's whole
 *   meaning), the same app-created universe as DingTalk messaging.
 * - `content` → msgtype `text` only. WeCom has a `markdown` msgtype — a
 *   future content upgrade, the same deferred decision as the Feishu
 *   batch.
 *
 * Silently-dropped limits (recorded here because upstream never errors on
 * them — unmappable by construction): message/send drops beyond 30
 * msgs/min and 1000/hour per member per app; appchat/send drops beyond
 * 200 msgs/min and 10 000/day per member. The connector's conservative
 * 60/min declaration is the platform-side hedge, to be adjusted after a
 * live pass measures WeCom's real budgets.
 *
 * `test_connection` is the token-acquisition proof (ADR-0017): the
 * execution boundary fetches the app token (gettoken via the cached cell)
 * BEFORE dispatch, so a handler that runs at all has proven the creds —
 * and no harmless send probe exists on WeCom to prove more. The handler
 * makes no upstream call.
 */
export class WeComConnector implements IConnector {
  readonly manifest = {
    id: WECOM_CONNECTOR_ID,
    provider: 'wecom' as const,
    implements: [
      'test_connection',
      // Chat path (app-created groups) and email path (get_userid_by_email
      // → touser) both landed in the first WeCom messaging batch (#47).
      'send_message',
    ],
    // Conservative (candidate 60/min per #47): WeCom silently drops member
    // messages over its per-member caps without erroring, so the boundary
    // throttles well below them; adjust after a live pass.
    rateLimit: { requestsPerMinute: 60 },
  };

  private readonly handlers: Record<string, ActionHandler>;
  private readonly http: UpstreamHttp;
  /**
   * The self-built app's agentid per tenant — the connection's identity,
   * resolved by the composition root from the credentials registered via
   * the admin `wecom-creds` endpoint. A tenant without one cannot send:
   * the handler fails loudly with the operator action (an operator-config
   * gap, so upstream_error, not a validation problem of the args).
   */
  private readonly getAgentId: ((tenantId: string) => Promise<string | undefined>) | undefined;

  constructor(
    apiBaseUrl: string,
    options: { getAgentId?: (tenantId: string) => Promise<string | undefined> } = {},
  ) {
    this.getAgentId = options.getAgentId;
    // The WeCom kernel profile (#48): query-param auth (?access_token=)
    // and the errcode envelope — one profile shared by the OAuth client
    // (gettoken) and this connector's business calls.
    this.http = createWeComHttp(apiBaseUrl);

    this.handlers = {
      test_connection: (_args, ctx) => {
        // No upstream call (see class comment): the boundary's token
        // acquisition already proved corpid+secret by fetching (or
        // holding) a valid app token. Reaching this line IS the proof;
        // ctx.token's presence is the acquired evidence.
        const output: TestConnectionOutput = {
          connection_id: ctx.connectionId,
          status: 'ok',
        };
        return output;
      },

      send_message: async (args: SendMessageInput, ctx) => {
        const input = args;
        if (input.email !== undefined) {
          // agentid is the USER path's identity bit only — the appchat path
          // carries no agentid, so the chat branch never resolves it.
          const agentid = await this.resolveAgentId(ctx.tenantId);
          return this.sendToUser(input.email, input.content, agentid, ctx);
        }
        return this.sendToChat(input.chat_id!, input.content, ctx);
      },
    };
  }

  execute(action: string, args: unknown, ctx: ActionContext): Promise<unknown> {
    const handler = this.handlers[action];
    if (!handler) {
      // Unreachable through the executor (implements check); defensive for
      // direct misuse. A plain error becomes upstream_error at Seam A.
      return Promise.reject(new Error(`Action "${action}" is not implemented by ${WECOM_CONNECTOR_ID}`));
    }
    return Promise.resolve(handler(args, ctx));
  }

  /** email → userid → message/send, with the two-namespace probe. */
  private async sendToUser(
    email: string,
    content: string,
    agentid: number,
    ctx: ActionContext,
  ): Promise<SendMessageOutput> {
    const userid = await this.resolveUserid(email, ctx.token);
    const response = await this.wecomRequest<MessageSendResponse>('/cgi-bin/message/send', {
      method: 'POST',
      token: ctx.token,
      body: {
        touser: userid,
        msgtype: 'text',
        // WeCom documents agentid as an integer (整型) — the string the
        // creds store holds is converted at this boundary only.
        agentid,
        text: { content },
      },
    });
    if (!response.msgid) {
      // errcode 0 means accepted — the message WAS sent. Say so, so the
      // agent never blind-retries into a duplicate (same honesty as the
      // appchat path's documented-envelope case).
      throw new ActionError(
        'upstream_error',
        'WeCom accepted the message but message/send returned no msgid: ' +
          'the message was sent, do not retry',
      );
    }
    return { message_id: response.msgid };
  }

  /** chat_id → appchat/send (app-created groups only, upstream-enforced). */
  private async sendToChat(
    chatId: string,
    content: string,
    ctx: ActionContext,
  ): Promise<SendMessageOutput> {
    const response = await this.wecomRequest<AppChatSendResponse>('/cgi-bin/appchat/send', {
      method: 'POST',
      token: ctx.token,
      body: {
        chatid: chatId,
        msgtype: 'text',
        text: { content },
      },
    });
    if (!response.msgid) {
      // The DOCUMENTED appchat/send envelope is errcode/errmsg only; the
      // live API returns msgid (SDK-observed — the live pass pins it). If
      // the id is ever absent the message WAS sent: say so, so the agent
      // never blind-retries into a duplicate.
      throw new ActionError(
        'upstream_error',
        'WeCom accepted the chat message but returned no msgid (the documented appchat/send ' +
          'envelope carries none): the message was sent, do not retry',
      );
    }
    return { message_id: response.msgid };
  }

  /**
   * email → userid across WeCom's two lookup namespaces: email_type 1
   * (企业邮箱) first, 2 (个人邮箱) on a 60111 miss. Only the combined miss
   * is not_found — a single miss is just the wrong namespace. WeCom locks
   * this endpoint for a day after many errors, so the probe is exactly
   * two calls and stops at the first hit.
   */
  private async resolveUserid(
    email: string,
    token: string | undefined,
  ): Promise<string> {
    for (const emailType of [1, 2] as const) {
      let response: GetUseridByEmailResponse;
      try {
        response = await this.http<GetUseridByEmailResponse>('/cgi-bin/user/get_userid_by_email', {
          method: 'POST',
          token,
          body: { email, email_type: emailType },
        });
      } catch (err) {
        if (err instanceof WeComApiError && err.errcode === USERID_NOT_FOUND) {
          continue; // wrong namespace — probe the other one
        }
        throw this.toVocabulary(err);
      }
      if (typeof response.userid !== 'string' || response.userid === '') {
        throw new ActionError(
          'upstream_error',
          'WeCom get_userid_by_email response omitted userid despite errcode 0',
        );
      }
      return response.userid;
    }
    throw new ActionError(
      'not_found',
      `No WeCom member found for email "${email}" (neither the corporate nor the personal ` +
        'email namespace resolved it)',
      { upstream: { code: String(USERID_NOT_FOUND), message: 'userid not found' } },
    );
  }

  /** The connection's identity, as the integer message/send wants it. */
  private async resolveAgentId(tenantId: string): Promise<number> {
    if (!this.getAgentId) {
      throw new ActionError(
        'upstream_error',
        `WeCom connector has no agentid provider configured (composition root) — send_message ` +
          'needs the self-built app\u2019s agentid; register credentials via ' +
          'POST /admin/tenants/<tenantId>/wecom-creds',
      );
    }
    const agentId = await this.getAgentId(tenantId);
    if (agentId === undefined || agentId === '') {
      throw new ActionError(
        'upstream_error',
        `Tenant "${tenantId}" has no WeCom credentials registered — send_message needs the ` +
          'self-built app\u2019s agentid; register credentials via ' +
          'POST /admin/tenants/<tenantId>/wecom-creds',
      );
    }
    const numeric = Number(agentId);
    if (!Number.isInteger(numeric)) {
      throw new ActionError(
        'upstream_error',
        `Tenant "${tenantId}" WeCom agentid "${agentId}" is not numeric — WeCom documents ` +
          'agentid as an integer; fix the registered credentials via the wecom-creds admin endpoint',
      );
    }
    return numeric;
  }

  /**
   * One business call with the envelope mapped into the unified
   * vocabulary: the shared WeCom profile throws `WeComApiError` (the
   * cached token cell classifies those itself, #48), so this wrapper owns
   * the ActionError translation — the connector's error seam.
   */
  private async wecomRequest<T>(path: string, opts: { method: 'POST'; token?: string; body: unknown }): Promise<T> {
    try {
      return await this.http<T>(path, opts);
    } catch (err) {
      throw this.toVocabulary(err);
    }
  }

  private toVocabulary(err: unknown): unknown {
    if (err instanceof WeComApiError) return mapWeComError(err);
    return err;
  }
}

/** The get_userid_by_email response (official-docs shape). */
interface GetUseridByEmailResponse {
  errcode?: number;
  errmsg?: string;
  userid?: string;
}

/** The message/send response: msgid is documented (发送成功后返回, 用于撤回). */
interface MessageSendResponse {
  msgid?: string;
}

/**
 * The appchat/send response: the DOCUMENTED envelope is errcode/errmsg
 * only, but the live API returns msgid (SDK-observed) — the connector uses
 * it when present and fails honestly when not (see sendToChat).
 */
interface AppChatSendResponse {
  msgid?: string;
}
