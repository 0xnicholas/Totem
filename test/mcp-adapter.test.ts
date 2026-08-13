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
  makeDeprecatedAction,
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
    // fake connector implements all of them: the full registry is exposed,
    // name-sorted (the registry's visible view — ADR-0002's filter now
    // starts from ActionRegistry.visibleActions()).
    const all = await adapter.listTools(TENANT_A, CONN_1);
    expect(all.map((t) => t.name)).toEqual([
      'append_doc_content',
      'create_doc',
      'export_doc',
      'feishu_read_bitable_records',
      'feishu_write_bitable_records',
      'get_doc_content',
      'get_doc_metadata',
      'move_doc',
      'read_sheet_cells',
      'rename_doc',
      'search_docs',
      'test_connection',
      'write_sheet_cells',
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

  it('annotates tools from the action effects class (T10)', async () => {
    const { executor, allowlists } = makeHarness();
    const adapter = new McpAdapter(executor, allowlists);

    const tools = await adapter.listTools(TENANT_A, CONN_1);
    const byName = new Map(tools.map((tool) => [tool.name, tool]));

    // read → readOnlyHint, nothing else.
    expect(byName.get('search_docs')?.annotations).toEqual({ readOnlyHint: true });
    expect(byName.get('get_doc_content')?.annotations).toEqual({ readOnlyHint: true });
    // test_connection is a read class action too.
    expect(byName.get('test_connection')?.annotations).toEqual({ readOnlyHint: true });
    // write → no hints at all: a mutation is not marked destructive.
    expect(byName.get('create_doc')?.annotations).toBeUndefined();
    expect(byName.get('write_sheet_cells')?.annotations).toBeUndefined();
  });

  it('maps a destructive action to destructiveHint (T10)', async () => {
    const destructiveAction = {
      name: 'delete_doc',
      description: 'Permanently deletes a document.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: { doc_id: { type: 'string' } },
        required: ['doc_id'],
      },
      outputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: { doc_id: { type: 'string' } },
        required: ['doc_id'],
      },
      effects: 'destructive' as const,
    };
    const connector = makeConnector('destructive', ['delete_doc'], {
      delete_doc: (args) => ({ doc_id: (args as { doc_id: string }).doc_id }),
    });
    const allowlists = new InMemoryAllowlistStore();
    allowlists.setAllowed(TENANT_A, CONN_1, ['delete_doc']);
    const executor = createActionExecutor({
      actions: [destructiveAction],
      connectors: [connector],
      connections: [{ ...CONN_1_A, connectorId: 'destructive' }],
      allowlists,
      audit: new InMemoryAuditSink(),
    });
    const adapter = new McpAdapter(executor, allowlists);

    const tools = await adapter.listTools(TENANT_A, CONN_1);
    expect(tools).toEqual([
      expect.objectContaining({ name: 'delete_doc', annotations: { destructiveHint: true } }),
    ]);
  });

  it('never advertises hidden actions, which remain executable (T10)', async () => {
    const hiddenAction = {
      name: 'platform_internal',
      description: 'Platform internal bookkeeping.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {},
        required: [],
      },
      outputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: { done: { type: 'boolean' } },
        required: ['done'],
      },
      effects: 'write' as const,
      hidden: true,
    };
    const connector = makeConnector('with-hidden', ['create_doc', 'platform_internal'], {
      create_doc: (args) => {
        const input = args as { title: string };
        return { doc_id: 'doc-1', title: input.title };
      },
      platform_internal: () => ({ done: true }),
    });
    const allowlists = new InMemoryAllowlistStore();
    allowlists.setAllowed(TENANT_A, CONN_1, ['create_doc', 'platform_internal']);
    const executor = createActionExecutor({
      actions: [hiddenAction, ...DOCS_ACTIONS],
      connectors: [connector],
      connections: [{ ...CONN_1_A, connectorId: 'with-hidden' }],
      allowlists,
      audit: new InMemoryAuditSink(),
    });
    const adapter = new McpAdapter(executor, allowlists);

    const tools = await adapter.listTools(TENANT_A, CONN_1);
    expect(tools.map((t) => t.name)).toEqual(['create_doc']);
    // Not visible and not callable over MCP — a stale client calling it is
    // invalid params, but the executor itself still runs it.
    await expect(adapter.getTool(TENANT_A, CONN_1, 'platform_internal')).resolves.toBeUndefined();
    const result = await executor.executeAction(TENANT_A, CONN_1, 'platform_internal', {});
    expect(result).toMatchObject({ ok: true, output: { done: true } });
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

  it('prefixes a deprecated tool description with the ADR-0014 marker; the stored description stays clean', async () => {
    const deprecated = makeDeprecatedAction({
      outputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: { doc_id: { type: 'string' } },
        required: ['doc_id'],
      },
    });
    const connector = makeConnector('deprecation', ['create_doc', 'legacy_export'], {
      create_doc: (args) => {
        const input = args as { title: string };
        return { doc_id: 'doc-1', title: input.title };
      },
      legacy_export: () => ({ doc_id: 'doc-1' }),
    });
    const allowlists = new InMemoryAllowlistStore();
    allowlists.setAllowed(TENANT_A, CONN_1, ['create_doc', 'legacy_export']);
    const executor = createActionExecutor({
      actions: [deprecated, ...DOCS_ACTIONS],
      connectors: [connector],
      connections: [{ ...CONN_1_A, connectorId: 'deprecation' }],
      allowlists,
      audit: new InMemoryAuditSink(),
    });
    const adapter = new McpAdapter(executor, allowlists);

    const marker = '[DEPRECATED — use export_doc, sunset 2026-09-01]';
    const tools = await adapter.listTools(TENANT_A, CONN_1);
    expect(tools.find((t) => t.name === 'legacy_export')?.description).toBe(
      `${marker} The old export shape.`,
    );
    // The marker lives only in the adapter's projection: the registry's
    // stored description is the single clean source (ADR-0014's sole
    // exception to "descriptions carry no marking").
    expect(
      executor.listVisibleActions().find((a) => a.name === 'legacy_export')?.description,
    ).toBe('The old export shape.');
    // getTool resolves through the same projection.
    await expect(adapter.getTool(TENANT_A, CONN_1, 'legacy_export')).resolves.toMatchObject({
      name: 'legacy_export',
      description: `${marker} The old export shape.`,
    });
    // A non-deprecated sibling in the same list carries no marker.
    expect(tools.find((t) => t.name === 'create_doc')?.description).not.toMatch(/^\[DEPRECATED/);
  });

  it('falls back to marker-only forms when replacement or sunset is absent', async () => {
    const sunsetOnly = {
      name: 'old_search',
      description: 'Search without relevance ranking.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {},
        required: [],
      },
      outputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {},
        required: [],
      },
      effects: 'read' as const,
      deprecated: { sunset: '2026-09-01' },
    };
    const noteOnly = {
      name: 'old_move',
      description: 'Move without conflict handling.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {},
        required: [],
      },
      outputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {},
        required: [],
      },
      effects: 'write' as const,
      deprecated: { note: 'Prefer move_doc.' },
    };
    const connector = makeConnector('markers', ['old_search', 'old_move'], {
      old_search: () => ({}),
      old_move: () => ({}),
    });
    const allowlists = new InMemoryAllowlistStore();
    allowlists.setAllowed(TENANT_A, CONN_1, ['old_search', 'old_move']);
    const executor = createActionExecutor({
      actions: [sunsetOnly, noteOnly],
      connectors: [connector],
      connections: [{ ...CONN_1_A, connectorId: 'markers' }],
      allowlists,
      audit: new InMemoryAuditSink(),
    });
    const adapter = new McpAdapter(executor, allowlists);

    const tools = await adapter.listTools(TENANT_A, CONN_1);
    expect(tools.find((t) => t.name === 'old_search')?.description).toBe(
      '[DEPRECATED — sunset 2026-09-01] Search without relevance ranking.',
    );
    expect(tools.find((t) => t.name === 'old_move')?.description).toBe(
      '[DEPRECATED] Move without conflict handling.',
    );
  });
});
