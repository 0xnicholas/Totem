import { describe, expect, it } from 'vitest';
import { ConnectionStore, createActionExecutor, type IConnector } from '../src/index.js';
import { CONNECTION_ACTIONS, DOCS_ACTIONS } from '../src/actions.js';
import { TokenRoutingProvider } from '../src/token-routing.js';
import { InMemoryAllowlistStore, InMemoryAuditSink } from '../src/testing/memory-governance.js';
import { FakeConnector } from '../src/testing/fake-connector.js';

const TENANT = 'tenant-routing';
const FEISHU_CONN = 'conn-feishu';
const DINGTALK_CONN = 'conn-dingtalk';

/**
 * The composition-root token routing (T17a AC-3): one TokenProvider seam
 * for the executor, dispatching per Connection by connector id — Feishu
 * and DingTalk connections each reach their own token manager.
 */
describe('TokenRoutingProvider', () => {
  it('routes each connection to its connector\'s token provider', async () => {
    const connections = new ConnectionStore([
      { tenantId: TENANT, connectionId: FEISHU_CONN, connectorId: 'feishu_docs' },
      { tenantId: TENANT, connectionId: DINGTALK_CONN, connectorId: 'dingtalk_docs' },
    ]);
    const feishuProvider = { getValidAccessToken: (id: string) => Promise.resolve(`feishu-token:${id}`) };
    const dingtalkProvider = { getValidAccessToken: (id: string) => Promise.resolve(`dingtalk-token:${id}`) };
    const routing = new TokenRoutingProvider(connections, {
      feishu_docs: feishuProvider,
      dingtalk_docs: dingtalkProvider,
    });

    await expect(routing.getValidAccessToken(FEISHU_CONN)).resolves.toBe(
      `feishu-token:${FEISHU_CONN}`,
    );
    await expect(routing.getValidAccessToken(DINGTALK_CONN)).resolves.toBe(
      `dingtalk-token:${DINGTALK_CONN}`,
    );
  });

  it('fails with upstream_error for an unknown connection', async () => {
    const routing = new TokenRoutingProvider(new ConnectionStore([]), {
      feishu_docs: { getValidAccessToken: () => Promise.resolve('x') },
    });
    await expect(routing.getValidAccessToken('no-such-conn')).rejects.toMatchObject({
      code: 'upstream_error',
    });
  });

  it('fails with upstream_error when no provider is registered for the connector', async () => {
    const connections = new ConnectionStore([
      { tenantId: TENANT, connectionId: 'conn-x', connectorId: 'unregistered' },
    ]);
    const routing = new TokenRoutingProvider(connections, {});
    await expect(routing.getValidAccessToken('conn-x')).rejects.toMatchObject({
      code: 'upstream_error',
    });
  });
});

/**
 * Seam A (T17a AC-3): a two-connector executor — Feishu-style fake and a
 * DingTalk-named connection — dispatches both through one boundary, each
 * with its own token source. This pins that the executor seam itself did
 * not change for the second connector.
 */
describe('executor with routed token acquisition (two connectors)', () => {
  it('places each connector\'s token in ActionContext and audits both', async () => {
    const allowlists = new InMemoryAllowlistStore();
    allowlists.setAllowed(TENANT, FEISHU_CONN, ['test_connection']);
    allowlists.setAllowed(TENANT, DINGTALK_CONN, ['test_connection']);
    const audit = new InMemoryAuditSink();

    const executor = createActionExecutor({
      actions: [...DOCS_ACTIONS, ...CONNECTION_ACTIONS],
      // The real DingTalk connector is covered at Seam B; here a stub with
      // the same manifest id stands in so the test stays about routing.
      connectors: [new FakeConnector(), dingtalkStubConnector()],
      connections: [
        { tenantId: TENANT, connectionId: FEISHU_CONN, connectorId: 'fake' },
        { tenantId: TENANT, connectionId: DINGTALK_CONN, connectorId: 'dingtalk_docs' },
      ],
      allowlists,
      audit,
      tokenProvider: new TokenRoutingProvider(
        new ConnectionStore([
          { tenantId: TENANT, connectionId: FEISHU_CONN, connectorId: 'fake' },
          { tenantId: TENANT, connectionId: DINGTALK_CONN, connectorId: 'dingtalk_docs' },
        ]),
        {
          fake: { getValidAccessToken: () => Promise.resolve('fake-token') },
          dingtalk_docs: { getValidAccessToken: () => Promise.resolve('dingtalk-token') },
        },
      ),
    });

    const feishuResult = await executor.executeAction(TENANT, FEISHU_CONN, 'test_connection', {}, 'cli');
    expect(feishuResult.ok).toBe(true);
    const dingtalkResult = await executor.executeAction(TENANT, DINGTALK_CONN, 'test_connection', {}, 'cli');
    expect(dingtalkResult.ok).toBe(true);

    const rows = audit.list();
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.connectionId).sort()).toEqual([DINGTALK_CONN, FEISHU_CONN]);
    expect(rows.every((r) => r.success)).toBe(true);
  });
});

/** A minimal `dingtalk_docs` manifest stub for the routing test. */
function dingtalkStubConnector(): IConnector {
  return {
    manifest: { id: 'dingtalk_docs', provider: 'dingtalk', implements: ['test_connection'] },
    execute: (_action, _args, ctx) => Promise.resolve({
      connection_id: ctx.connectionId,
      status: 'ok',
    }),
  };
}
