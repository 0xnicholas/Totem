import { randomUUID } from 'node:crypto';
import { errorMessage } from '../errors.js';
import { encryptValue } from '../crypto.js';
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

/**
 * The Authorize Flow (CONTEXT.md): the minimal OAuth dance that opens a
 * connection. Provider adapters satisfy this interface by composing the
 * state machine below with their endpoint client.
 */
export interface OAuthFlow {
  /**
   * Starts the authorization-code flow: verifies the tenant has
   * credentials, records the pending state, and returns the authorization
   * URL for the user's browser.
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
   * Handles the redirect: validates the state, exchanges the code,
   * creates (or re-authorizes) the connection, and stores the token pair
   * encrypted.
   * @throws FlowError(400) for bad state/code/missing creds, FlowError(500)
   * for internal failures.
   */
  handleCallback(code: string, state: string): Promise<void>;
}

/** The provider-specific half of the Authorize Flow — the adapter side of the seam (ADR-0015). */
export interface AuthorizeProfile<TCreds> {
  /** Provider display name in failure messages ("Feishu", "DingTalk"). */
  providerName: string;
  /** Reads the tenant's app credentials; undefined means the tenant never configured them. */
  getCreds(tenantId: string): Promise<TCreds | undefined>;
  /** The FlowError(400) message when the tenant has no credentials. */
  noCredsMessage(tenantId: string): string;
  /** Builds the provider's authorization URL (creds + redirect + state). */
  buildAuthorizationUrl(creds: TCreds, redirectUri: string, state: string): string;
  /**
   * Exchanges the callback code for a token pair. `redirectUri` is passed
   * through for providers that bind the code to it; providers that don't
   * (DingTalk) ignore it.
   */
  exchangeCode(creds: TCreds, code: string, redirectUri: string): Promise<TokenPair>;
  /** True for failures the caller can fix (bad code/creds, rate limits) → FlowError(400). */
  isCallerError(err: unknown): boolean;
}

/** A fresh pair as returned by the code exchange. */
export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  /** ISO timestamp when the access token expires. */
  expiresAt: string;
}

export const DEFAULT_STATE_TTL_MS = 10 * 60 * 1000;

interface PendingFlow {
  tenantId: string;
  redirectUri: string;
  createdAt: number;
  /** Re-authorize this existing connection instead of creating one. */
  connectionId?: string;
}

/**
 * The Authorize Flow state machine (ADR-0015): the admin starts the flow,
 * the user authorizes in the provider, the callback exchanges the code for
 * tokens, and a connection record is created. Pending states live in
 * memory with a TTL (v1: a restart mid-flow simply invalidates the state —
 * the operator restarts the flow).
 *
 * Provider adapters (feishu, dingtalk) supply the profile; the machine
 * owns everything else — state recording and TTL, connection-first-then-
 * tokens ordering, and encrypted storage.
 */
export function createOAuthFlow<TCreds>(
  profile: AuthorizeProfile<TCreds>,
  deps: {
    tokenStore: TokenStore;
    connections: ConnectionCreator;
    masterKey: string;
    /** The connector the flow creates connections for (provider identity). */
    connectorId: string;
    /** The connection name recorded on create (provider identity). */
    connectionName: string;
    stateTtlMs?: number;
    now?: () => number;
  },
): OAuthFlow {
  const pending = new Map<string, PendingFlow>();
  const now = deps.now ?? Date.now;
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
        authorizationUrl: profile.buildAuthorizationUrl(creds, redirectUri, state),
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

      let pair: TokenPair;
      try {
        pair = await profile.exchangeCode(creds, code, flow.redirectUri);
      } catch (err) {
        if (profile.isCallerError(err)) {
          // Grant rejections (bad code, bad creds) and rate limits are the
          // caller's problem (400); network and other failures are ours (500).
          throw new FlowError(400, `${profile.providerName} authorization failed: ${errorMessage(err)}`);
        }
        throw new FlowError(500, `${profile.providerName} authorization failed: ${errorMessage(err)}`);
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
            connectorId: deps.connectorId,
            name: deps.connectionName,
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
  async function requireCreds(tenantId: string): Promise<TCreds> {
    const creds = await profile.getCreds(tenantId);
    if (!creds) {
      throw new FlowError(400, profile.noCredsMessage(tenantId));
    }
    return creds;
  }
}
