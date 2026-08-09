import { describe, expect, it } from 'vitest';
import { DOCS_ACTIONS, createActionExecutor } from '../src/index.js';
import { McpAdapter } from '../src/mcp/adapter.js';
import { InMemoryAllowlistStore, InMemoryAuditSink } from '../src/testing/memory-governance.js';
import {
  CONN_1,
  CONN_1_A,
  TENANT_A,
  TENANT_B,
  makeConnector,
  makeHarness,
} from './fixtures.js';

/**
 * The MCP adapter (T5): the thin protocol-agnostic view of the action layer
 * that the MCP transport hangs off. Tool listing is registry ∩ allowlist ∩
 * connector implements (ADR-0002 hide-don't-reject); calls route through
 * executeAction, so allowlist + audit (T4) apply unchanged.
 */
describe('McpAdapter', () => {
  it('lists tools as the intersection of registry, allowlist and connector implements', async () => {
    const { executor, allowlists } = makeHarness();
    const adapter = new McpAdapter(executor, allowlists);

    // Default harness allowlist permits every registered action, and the
    // fake connector implements all of them: the full registry is exposed.
    const all = await adapter.listTools(TENANT_A, CONN_1);
    expect(all.map((t) => t.name)).toEqual([
      'create_doc',
      'search_docs',
      'get_doc_content',
      'get_doc_metadata',
      'append_doc_content',
      'rename_doc',
      'move_doc',
      'export_doc',
      'read_sheet_cells',
      'write_sheet_cells',
      'read_bitable_records',
      'write_bitable_records',
    ]);
    const createDoc = all.find((t) => t.name === 'create_doc');
    expect(createDoc?.description).toBeTruthy();
    expect(createDoc?.inputSchema).toMatchObject({ type: 'object' });

    // An allowlist subset hides the rest — the agent never sees tools it
    // cannot use.
    allowlists.setAllowed(TENANT_A, CONN_1, ['get_doc_content']);
    await expect(adapter.listTools(TENANT_A, CONN_1)).resolves.toEqual([
      expect.objectContaining({ name: 'get_doc_content' }),
    ]);
  });

  it('hides actions the connection\'s connector does not implement', async () => {
    // A connector implementing only create_doc, with a fully permissive
    // allowlist: the tool list is still limited to what can execute.
    const subsetConnector = makeConnector('subset', ['create_doc'], {
      create_doc: (args) => {
        const input = args as { title: string };
        return { doc_id: 'doc-1', title: input.title, url: 'https://fake.totem.local/docs/doc-1' };
      },
    });
    const allowlists = new InMemoryAllowlistStore();
    allowlists.setAllowed(
      TENANT_A,
      CONN_1,
      DOCS_ACTIONS.map((a) => a.name),
    );
    const executor = createActionExecutor({
      actions: DOCS_ACTIONS,
      connectors: [subsetConnector],
      connections: [{ ...CONN_1_A, connectorId: 'subset' }],
      allowlists,
      audit: new InMemoryAuditSink(),
    });
    const adapter = new McpAdapter(executor, allowlists);
    const tools = await adapter.listTools(TENANT_A, CONN_1);
    expect(tools.map((t) => t.name)).toEqual(['create_doc']);
  });

  it('hides every tool when the allowlist is empty (fail-closed)', async () => {
    const { executor, allowlists } = makeHarness();
    allowlists.setAllowed(TENANT_A, CONN_1, []);
    const adapter = new McpAdapter(executor, allowlists);
    await expect(adapter.listTools(TENANT_A, CONN_1)).resolves.toEqual([]);
  });

  it('isolates tool lists per (tenant, connection)', async () => {
    const { executor, allowlists } = makeHarness();
    allowlists.setAllowed(TENANT_A, CONN_1, ['create_doc']);
    const adapter = new McpAdapter(executor, allowlists);

    // Same connection id under another tenant does not exist.
    await expect(adapter.listTools(TENANT_B, CONN_1)).resolves.toEqual([]);
    await expect(adapter.resolveConnection(TENANT_B, CONN_1)).resolves.toBeUndefined();
    // Unknown connection id under the right tenant is also nothing.
    await expect(adapter.listTools(TENANT_A, 'conn-unknown')).resolves.toEqual([]);
  });

  it('getTool returns the definition only for visible tools', async () => {
    const { executor, allowlists } = makeHarness();
    allowlists.setAllowed(TENANT_A, CONN_1, ['create_doc']);
    const adapter = new McpAdapter(executor, allowlists);

    await expect(adapter.getTool(TENANT_A, CONN_1, 'create_doc')).resolves.toMatchObject({
      name: 'create_doc',
    });
    await expect(adapter.getTool(TENANT_A, CONN_1, 'get_doc_content')).resolves.toBeUndefined();
    await expect(adapter.getTool(TENANT_A, 'conn-unknown', 'create_doc')).resolves.toBeUndefined();
  });

  it('callTool routes through executeAction: success writes a source-mcp audit row', async () => {
    const { executor, allowlists, audit } = makeHarness();
    const adapter = new McpAdapter(executor, allowlists);

    const result = await adapter.callTool(TENANT_A, CONN_1, 'create_doc', { title: 'MCP draft' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.output).toMatchObject({ title: 'MCP draft' });

    const rows = audit.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tenantId: TENANT_A,
      connectionId: CONN_1,
      actionName: 'create_doc',
      source: 'mcp',
      success: true,
      errorCode: null,
    });
  });

  it('callTool preserves the unified vocabulary when the allowlist denies (defense in depth)', async () => {
    const { executor, allowlists, audit } = makeHarness();
    allowlists.setAllowed(TENANT_A, CONN_1, ['get_doc_content']);
    const adapter = new McpAdapter(executor, allowlists);

    const result = await adapter.callTool(TENANT_A, CONN_1, 'create_doc', { title: 'nope' });
    expect(result).toMatchObject({ ok: false, error: { code: 'forbidden', retryable: false } });
    expect(audit.list()[0]).toMatchObject({ actionName: 'create_doc', success: false, errorCode: 'forbidden' });
  });

  it('callTool surfaces validation errors with details', async () => {
    const { executor, allowlists } = makeHarness();
    const adapter = new McpAdapter(executor, allowlists);

    const result = await adapter.callTool(TENANT_A, CONN_1, 'create_doc', {});
    expect(result).toMatchObject({ ok: false, error: { code: 'validation_error' } });
    if (!result.ok) {
      expect(result.error.details).toBeDefined();
    }
  });

  it('callTool on an unknown connection fails without an audit row (FK boundary)', async () => {
    const { executor, allowlists, audit } = makeHarness();
    const adapter = new McpAdapter(executor, allowlists);

    const result = await adapter.callTool(TENANT_A, 'conn-unknown', 'create_doc', { title: 'x' });
    expect(result).toMatchObject({ ok: false, error: { code: 'not_found' } });
    expect(audit.list()).toHaveLength(0);
  });
});
