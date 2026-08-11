import { randomUUID } from 'node:crypto';
import { encryptValue } from '../feishu/crypto.js';
import type { DingTalkAppCredentials, DingTalkCredsStore } from './creds-store.js';
import { errorMessage } from '../errors.js';
import { DingTalkApiError, type DingTalkOAuthClient } from './oauth.js';
import type { TokenStore } from '../feishu/token-store.js';
import type { ConnectionCreator, OAuthFlow } from '../feishu/flow.js';
import { FlowError } from '../feishu/flow.js';

export type { OAuthFlow } from '../feishu/flow.js';

const DEFAULT_CONNECTOR_ID = 'dingtalk_docs';
const DEFAULT_CONNECTION_NAME = 'dingtalk';
const DEFAULT_STATE_TTL_MS = 10 * 60 * 1000;

interface PendingFlow {
  tenantId: string;
  redirectUri: string;
  createdAt: number;
  /** Re-authorize this existing connection instead of creating one. */
  connectionId?: string;
}

/**
 * The OAuth authorization-code flow for DingTalk (T17a): CLI/admin starts
 * the flow, the user authorizes in DingTalk, the callback exchanges the
 * code for tokens, and a connection record is created. Pending states live
 * in memory with a TTL (v1: a restart mid-flow simply invalidates the
 * state — the operator restarts the flow).
 *
 * A deliberate mirror of the Feishu flow (same state-TTL and
 * connection-first-then-tokens ordering) with DingTalk's client and error
 * types; the two generalize into one shared module when a third connector
 * lands.
 */
export function createDingTalkOAuthFlow(deps: {
  credsStore: DingTalkCredsStore;
  tokenStore: TokenStore;
  oauth: DingTalkOAuthClient;
  connections: ConnectionCreator;
  masterKey: string;
  connectorId?: string;
  connectionName?: string;
  stateTtlMs?: number;
  now?: () => number;
}): OAuthFlow {
  const pending = new Map<string, PendingFlow>();
  const now = deps.now ?? Date.now;
  const connectorId = deps.connectorId ?? DEFAULT_CONNECTOR_ID;
  const connectionName = deps.connectionName ?? DEFAULT_CONNECTION_NAME;
  const stateTtlMs = deps.stateTtlMs ?? DEFAULT_STATE_TTL_MS;

  return {
    async start(tenantId, redirectUri, options) {
      const creds = await requireCreds(tenantId);
      const state = randomUUID();
      pending.set(state, {
        tenantId,
        redirectUri,
        createdAt: now(),
        ...(options?.connectionId !== undefined ? { connectionId: options.connectionId } : {}),
      });
      return {
        authorizationUrl: deps.oauth.buildAuthorizationUrl({
          appKey: creds.appKey,
          redirectUri,
          state,
        }),
      };
    },

    async handleCallback(code, state) {
      const flow = pending.get(state);
      if (!flow || now() - flow.createdAt > stateTtlMs) {
        // Consumed or expired: either way the state is dead.
        pending.delete(state);
        throw new FlowError(400, 'Unknown or expired OAuth state');
      }
      pending.delete(state);

      const creds = await requireCreds(flow.tenantId);

      let pair: Awaited<ReturnType<DingTalkOAuthClient['exchangeCode']>>;
      try {
        pair = await deps.oauth.exchangeCode({ creds, code });
      } catch (err) {
        if (err instanceof DingTalkApiError) {
          // Grant rejections (bad code, bad creds) and rate limits are the
          // caller's problem (400); network and non-envelope failures are
          // ours (500).
          if (err.invalidGrant || err.httpStatus === 429) {
            throw new FlowError(400, `DingTalk authorization failed: ${err.message}`);
          }
        }
        throw new FlowError(500, `DingTalk authorization failed: ${errorMessage(err)}`);
      }

      // Connection first, tokens second: a token-store failure leaves a
      // visible, re-runnable connection instead of orphan tokens (the
      // tokens table FKs the connection, so the reverse order is impossible
      // anyway).
      let connectionId: string;
      if (flow.connectionId !== undefined) {
        connectionId = flow.connectionId;
        // Re-authorization succeeded: the connection is live again.
        try {
          await deps.connections.activateConnection(connectionId);
        } catch (err) {
          throw new FlowError(500, `Connection re-activation failed: ${errorMessage(err)}`);
        }
      } else {
        try {
          const created = await deps.connections.createConnection(flow.tenantId, {
            connectorId,
            name: connectionName,
            oauthRedirectUri: flow.redirectUri,
          });
          connectionId = created.id;
        } catch (err) {
          throw new FlowError(500, `Connection creation failed: ${errorMessage(err)}`);
        }
      }

      await deps.tokenStore.upsert({
        tenantId: flow.tenantId,
        connectionId,
        accessTokenCiphertext: encryptValue(flow.tenantId, pair.accessToken, deps.masterKey),
        refreshTokenCiphertext: encryptValue(flow.tenantId, pair.refreshToken, deps.masterKey),
        expiresAt: pair.expiresAt,
      });
    },
  };

  /** One creds check shared by start and callback. */
  async function requireCreds(tenantId: string): Promise<DingTalkAppCredentials> {
    const creds = await deps.credsStore.get(tenantId);
    if (!creds) {
      throw new FlowError(
        400,
        `Tenant "${tenantId}" has no DingTalk credentials configured (set-dingtalk-creds)`,
      );
    }
    return creds;
  }
}
