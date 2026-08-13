import { ActionError } from './errors.js';
import type { ConnectionLookup } from './executor.js';
import type { TokenProvider } from './oauth/token-lifecycle.js';

/**
 * Composition-root token routing (T17a): one `TokenProvider` seam for the
 * executor, dispatching per Connection by connector id. The executor keeps
 * its single-provider contract (ADR-0004 — connectors never see OAuth);
 * this provider resolves the Connection's connector and delegates to that
 * connector's token manager (Feishu, DingTalk, …).
 *
 * Resolution is the lookup's by-id path (`getByConnectionId`): connection
 * ids are globally unique (migration 001), so one indexed lookup per
 * acquisition replaces the old full-set scan.
 */
export class TokenRoutingProvider implements TokenProvider {
  constructor(
    private readonly connections: ConnectionLookup,
    private readonly providers: Record<string, TokenProvider>,
  ) {}

  async getValidAccessToken(connectionId: string): Promise<string> {
    const record = await this.connections.getByConnectionId(connectionId);
    if (!record) {
      throw new ActionError(
        'upstream_error',
        `Connection "${connectionId}" not found during token acquisition`,
      );
    }
    const provider = this.providers[record.connectorId];
    if (!provider) {
      throw new ActionError(
        'upstream_error',
        `No token provider registered for connector "${record.connectorId}"`,
      );
    }
    return provider.getValidAccessToken(connectionId);
  }
}
