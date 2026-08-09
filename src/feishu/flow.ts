import { randomUUID } from 'node:crypto';
import { encryptValue } from './crypto.js';
import type { FeishuAppCredentials, FeishuCredsStore } from './creds-store.js';
import { errorMessage } from '../errors.js';
import { FeishuApiError, type FeishuOAuthClient } from './oauth.js';
import type { TokenStore } from './token-store.js';

/**
 * The flow's connection-creation dependency. Implemented by the admin
 * repository: the connection row carries a server-set owner (the tenant)
 * and the deployment's canonical OAuth redirect URI, recorded so re-auth
 * never breaks (StackOne research amendment).
 */
export interface ConnectionCreator {
  createConnection(
    tenantId: string,
    input: { connectorId: string; name: string; oauthRedirectUri: string | null },
  ): Promise<{ id: string }>;
  /** Re-activates a connection after a successful re-authorization. */
  activateConnection(connectionId: string): Promise<void>;
}

/**
 * A flow failure with an HTTP status for the admin route to surface:
 * 400 = the caller can fix it (unknown/expired state, missing creds,
 * rejected code), 500 = internal.
 */
export class FlowError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'FlowError';
    this.status = status;
  }
}

export interface OAuthFlow {
  /**
   * Starts the authorization-code flow: verifies the tenant has Feishu
   * credentials, records the pending state, and returns the Feishu
   * authorization URL for the user's browser.
   * @param connectionId when given, the callback re-authorizes this
   * existing connection in place (replacing its tokens) instead of
   * creating a new one — the re-auth path for `auth_expired` connections.
   * @throws FlowError(400) when the tenant has no credentials.
   */
  start(
    tenantId: string,
    redirectUri: string,
    options?: { connectionId?: string },
  ): Promise<{ authorizationUrl: string }>;
  /**
   * Handles the Feishu redirect: validates the state, exchanges the code,
   * creates (or re-authorizes) the connection, and stores the token pair
   * encrypted.
   * @throws FlowError(400) for bad state/code/missing creds, FlowError(500)
   * for internal failures.
   */
  handleCallback(code: string, state: string): Promise<void>;
}

const DEFAULT_CONNECTOR_ID = 'feishu_docs';
const DEFAULT_CONNECTION_NAME = 'feishu';
const DEFAULT_STATE_TTL_MS = 10 * 60 * 1000;

interface PendingFlow {
  tenantId: string;
  redirectUri: string;
  createdAt: number;
  /** Re-authorize this existing connection instead of creating one. */
  connectionId?: string;
}

/**
 * The OAuth authorization-code flow (T6 AC-1): CLI/admin starts the flow,
 * the user authorizes in Feishu, the callback exchanges the code for
 * tokens, and a connection record is created. Pending states live in
 * memory with a TTL (v1: a restart mid-flow simply invalidates the state —
 * the operator restarts the flow).
 */
export function createOAuthFlow(deps: {
  credsStore: FeishuCredsStore;
  tokenStore: TokenStore;
  oauth: FeishuOAuthClient;
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
          appId: creds.appId,
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

      let pair: Awaited<ReturnType<FeishuOAuthClient['exchangeCode']>>;
      try {
        pair = await deps.oauth.exchangeCode({ creds, code, redirectUri: flow.redirectUri });
      } catch (err) {
        if (err instanceof FeishuApiError) {
          // Grant rejections (bad code, bad creds) and rate limits are the
          // caller's problem (400); network and non-envelope failures are
          // ours (500).
          if (err.invalidGrant || err.httpStatus === 429) {
            throw new FlowError(400, `Feishu authorization failed: ${err.message}`);
          }
        }
        throw new FlowError(500, `Feishu authorization failed: ${errorMessage(err)}`);
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
  async function requireCreds(tenantId: string): Promise<FeishuAppCredentials> {
    const creds = await deps.credsStore.get(tenantId);
    if (!creds) {
      throw new FlowError(
        400,
        `Tenant "${tenantId}" has no Feishu credentials configured (set-feishu-creds)`,
      );
    }
    return creds;
  }
}
