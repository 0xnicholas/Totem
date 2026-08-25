import { describe, expect, it } from 'vitest';
import { DOCS_ACTIONS, MESSAGING_ACTIONS, createActionExecutor } from '../src/index.js';
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
 * that the MCP transport hangs off. The tool-list question lives at Seam A
 * (ADR-0002 hide-don't-reject: `executor.listAllowedTools` — registry ∩
 * allowlist ∩ connector implements ∩ visible), so this adapter translates
 * only the MCP wire format: tool definitions, annotations, the deprecation
 * marker. Calls route through executeAction, so allowlist + audit (T4)
 * apply unchanged.
 */
describe('McpAdapter', () => {
  it('annotates tools from the action effects class (T10)', async () => {
    const { executor } = makeHarness();
    const adapter = new McpAdapter(executor);

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
    const adapter = new McpAdapter(executor);

    const tools = await adapter.listTools(TENANT_A, CONN_1);
    expect(tools).toEqual([
      expect.objectContaining({ name: 'delete_doc', annotations: { destructiveHint: true } }),
    ]);
  });

  it('projects recall_message with destructiveHint (#60)', async () => {
    // The platform action straight from the registry (MESSAGING_ACTIONS),
    // behind a minimal implementing connector: the projection must carry
    // the class hint agents use to require user confirmation.
    const connector = makeConnector('recaller', ['recall_message'], {
      recall_message: () => ({}),
    });
    const allowlists = new InMemoryAllowlistStore();
    allowlists.setAllowed(TENANT_A, CONN_1, ['recall_message']);
    const executor = createActionExecutor({
      actions: [...MESSAGING_ACTIONS],
      connectors: [connector],
      connections: [{ ...CONN_1_A, connectorId: 'recaller' }],
      allowlists,
      audit: new InMemoryAuditSink(),
    });
    const adapter = new McpAdapter(executor);

    const tools = await adapter.listTools(TENANT_A, CONN_1);
    expect(tools).toEqual([
      expect.objectContaining({ name: 'recall_message', annotations: { destructiveHint: true } }),
    ]);
  });

  it('isolates tool lists per (tenant, connection)', async () => {
    const { executor, allowlists } = makeHarness();
    allowlists.setAllowed(TENANT_A, CONN_1, ['create_doc']);
    const adapter = new McpAdapter(executor);

    // Same connection id under another tenant does not exist.
    await expect(adapter.listTools(TENANT_B, CONN_1)).resolves.toEqual([]);
    await expect(adapter.resolveConnection(TENANT_B, CONN_1)).resolves.toBeUndefined();
    // Unknown connection id under the right tenant is also nothing.
    await expect(adapter.listTools(TENANT_A, 'conn-unknown')).resolves.toEqual([]);
  });

  it('getTool returns the definition only for visible tools', async () => {
    const { executor, allowlists } = makeHarness();
    allowlists.setAllowed(TENANT_A, CONN_1, ['create_doc']);
    const adapter = new McpAdapter(executor);

    await expect(adapter.getTool(TENANT_A, CONN_1, 'create_doc')).resolves.toMatchObject({
      name: 'create_doc',
    });
    await expect(adapter.getTool(TENANT_A, CONN_1, 'get_doc_content')).resolves.toBeUndefined();
    await expect(adapter.getTool(TENANT_A, 'conn-unknown', 'create_doc')).resolves.toBeUndefined();
  });

  it('callTool routes through executeAction: success writes a source-mcp audit row', async () => {
    const { executor, audit } = makeHarness();
    const adapter = new McpAdapter(executor);

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
    const adapter = new McpAdapter(executor);

    const result = await adapter.callTool(TENANT_A, CONN_1, 'create_doc', { title: 'nope' });
    expect(result).toMatchObject({ ok: false, error: { code: 'forbidden', retryable: false } });
    expect(audit.list()[0]).toMatchObject({ actionName: 'create_doc', success: false, errorCode: 'forbidden' });
  });

  it('callTool surfaces validation errors with details', async () => {
    const { executor } = makeHarness();
    const adapter = new McpAdapter(executor);

    const result = await adapter.callTool(TENANT_A, CONN_1, 'create_doc', {});
    expect(result).toMatchObject({ ok: false, error: { code: 'validation_error' } });
    if (!result.ok) {
      expect(result.error.details).toBeDefined();
    }
  });

  it('callTool on an unknown connection fails without an audit row (FK boundary)', async () => {
    const { executor, audit } = makeHarness();
    const adapter = new McpAdapter(executor);

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
    const adapter = new McpAdapter(executor);

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
    const adapter = new McpAdapter(executor);

    const tools = await adapter.listTools(TENANT_A, CONN_1);
    expect(tools.find((t) => t.name === 'old_search')?.description).toBe(
      '[DEPRECATED — sunset 2026-09-01] Search without relevance ranking.',
    );
    expect(tools.find((t) => t.name === 'old_move')?.description).toBe(
      '[DEPRECATED] Move without conflict handling.',
    );
  });
});
