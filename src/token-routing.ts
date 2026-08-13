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
 * Connection resolution uses the lookup's `list()` — an indexed-in-memory
 * scan of the connection set (internal-platform scale, sub-millisecond);
 * a call-site lookup by id would need a new lookup method, which no second
 * consumer has justified yet.
 */
export class TokenRoutingProvider implements TokenProvider {
  constructor(
    private readonly connections: ConnectionLookup,
    private readonly providers: Record<string, TokenProvider>,
  ) {}

  async getValidAccessToken(connectionId: string): Promise<string> {
    const records = await this.connections.list();
    const record = records.find((candidate) => candidate.connectionId === connectionId);
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
