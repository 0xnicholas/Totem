import type { Action, ActionExecutor, ActionHandler, ConnectionRecord, IConnector } from '../src/index.js';
import { DOCS_ACTIONS, createActionExecutor } from '../src/index.js';
import type { AllowlistStore, AuditSink } from '../src/governance.js';
import type { TokenProvider } from '../src/feishu/token-manager.js';
import { FAKE_CONNECTOR_ID, FakeConnector } from '../src/testing/fake-connector.js';
import { InMemoryAllowlistStore, InMemoryAuditSink } from '../src/testing/memory-governance.js';

export const TENANT_A = 'tenant-a';
export const TENANT_B = 'tenant-b';
export const CONN_1 = 'conn-1';
export { FAKE_CONNECTOR_ID };
export const MISBEHAVING_CONNECTOR_ID = 'misbehaving';

export const CONN_1_A: ConnectionRecord = {
  tenantId: TENANT_A,
  connectionId: CONN_1,
  connectorId: FAKE_CONNECTOR_ID,
};

/**
 * Seam A harness: executor plus the governance stores it was wired with.
 * When no allowlist store is passed, the harness seeds one allowing every
 * registered action on every seeded connection, so non-governance tests
 * exercise the rest of the seam unchanged; governance tests override with
 * `setAllowed` (replace semantics).
 */
export function makeHarness(config: {
  actions?: Action[];
  connectors?: IConnector[];
  connections?: ConnectionRecord[];
  allowlists?: AllowlistStore;
  audit?: AuditSink;
  tokenProvider?: TokenProvider;
} = {}): {
  executor: ActionExecutor;
  allowlists: InMemoryAllowlistStore;
  audit: InMemoryAuditSink;
} {
  const actions = config.actions ?? DOCS_ACTIONS;
  const connectors = config.connectors ?? [new FakeConnector()];
  const connections = config.connections ?? [CONN_1_A];
  const createdAllowlists = config.allowlists === undefined;
  const allowlists = config.allowlists ?? new InMemoryAllowlistStore();
  const audit = config.audit ?? new InMemoryAuditSink();
  if (createdAllowlists) {
    for (const connection of connections) {
      (allowlists as InMemoryAllowlistStore).setAllowed(
        connection.tenantId,
        connection.connectionId,
        actions.map((a) => a.name),
      );
    }
  }
  const executor = createActionExecutor({
    actions,
    connectors,
    connections,
    allowlists,
    audit,
    ...(config.tokenProvider !== undefined ? { tokenProvider: config.tokenProvider } : {}),
  });
  return { executor, allowlists: allowlists as InMemoryAllowlistStore, audit: audit as InMemoryAuditSink };
}

/** Executor with a fully-permissive allowlist (default harness), for T1-style tests. */
export function makeExecutor(config?: {
  actions?: Action[];
  connectors?: IConnector[];
  connections?: ConnectionRecord[];
}): ActionExecutor {
  return makeHarness(config).executor;
}

export const EMPTY_INPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {},
  required: [],
} as const;

export const EMPTY_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {},
  required: [],
} as const;

/** Minimal connector factory for registry-convention tests. */
export function makeConnector(
  id: string,
  implements_: string[],
  handlers: Record<string, ActionHandler>,
): IConnector {
  return {
    manifest: { id, implements: implements_ },
    execute: (action, args, ctx) => {
      const handler = handlers[action];
      if (!handler) {
        return Promise.reject(new Error(`Action "${action}" is not implemented by connector "${id}"`));
      }
      return Promise.resolve(handler(args, ctx));
    },
  };
}

/** Platform definitions for the misbehaving connector's actions. */
export const MISBEHAVING_ACTIONS: Action[] = [
  {
    name: 'malfunction_output',
    description: 'Declares a boolean ok field but returns a string.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { why: { type: 'string' } },
      required: [],
    },
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { ok: { type: 'boolean' } },
      required: ['ok'],
    },
  },
  {
    name: 'throw_noise',
    description: 'Throws a plain error instead of a vocabulary error.',
    inputSchema: EMPTY_INPUT_SCHEMA,
    outputSchema: EMPTY_OUTPUT_SCHEMA,
  },
];

/** Connector whose handler misbehaves in both possible ways. */
export function makeMisbehavingConnector(): IConnector {
  return makeConnector(MISBEHAVING_CONNECTOR_ID, ['malfunction_output', 'throw_noise'], {
    malfunction_output: () => ({ ok: 'not-a-boolean' }),
    throw_noise: () => {
      throw new Error('connector exploded');
    },
  });
}

/** Executor wired to the misbehaving connector only. */
export function makeMisbehavingExecutor(): ActionExecutor {
  return makeExecutor({
    actions: [...DOCS_ACTIONS, ...MISBEHAVING_ACTIONS],
    connectors: [makeMisbehavingConnector()],
    connections: [{ ...CONN_1_A, connectorId: MISBEHAVING_CONNECTOR_ID }],
  });
}
