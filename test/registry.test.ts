import { describe, expect, it } from 'vitest';
import { DOCS_ACTIONS } from '../src/index.js';
import { FAKE_CONNECTOR_ID, FakeConnector } from '../src/testing/fake-connector.js';
import {
  CONN_1_A,
  EMPTY_INPUT_SCHEMA,
  EMPTY_OUTPUT_SCHEMA,
  makeConnector,
  makeExecutor,
} from './fixtures.js';

describe('action registry (registration contract, ADR-0001/0003)', () => {
  it('registers the platform action set', () => {
    const executor = makeExecutor();

    const names = executor.listActions().map((a) => a.name).sort();
    expect(names).toEqual([
      'append_doc_content',
      'create_doc',
      'export_doc',
      'get_doc_content',
      'get_doc_metadata',
      'move_doc',
      'read_bitable_records',
      'read_sheet_cells',
      'rename_doc',
      'search_docs',
      'test_connection',
      'write_bitable_records',
      'write_sheet_cells',
    ]);
  });

  it('rejects a duplicate action name', () => {
    const duplicate = { ...DOCS_ACTIONS[0]!, description: 'Duplicate of create_doc.' };

    expect(() => makeExecutor({ actions: [...DOCS_ACTIONS, duplicate] })).toThrow(
      /Action "create_doc" is already registered/,
    );
  });

  it('rejects duplicate connector ids', () => {
    const duplicate = makeConnector(FAKE_CONNECTOR_ID, [], {});

    expect(() => makeExecutor({ connectors: [new FakeConnector(), duplicate] })).toThrow(
      /Connector "fake" is already registered/,
    );
  });

  it('rejects a connector that implements an unknown action', () => {
    const ghost = makeConnector('ghost', ['create_doc', 'nope_action'], {});

    expect(() => makeExecutor({ connectors: [new FakeConnector(), ghost] })).toThrow(
      /Connector "ghost" implements unknown action "nope_action"/,
    );
  });

  it('rejects action names that violate the verb_noun snake_case convention', () => {
    for (const badName of ['createDoc', 'create', 'Create_doc', 'create-doc']) {
      const bad = {
        name: badName,
        description: 'Bad name.',
        inputSchema: EMPTY_INPUT_SCHEMA,
        outputSchema: EMPTY_OUTPUT_SCHEMA,
        effects: 'read' as const,
      };

      expect(() => makeExecutor({ actions: [...DOCS_ACTIONS, bad] }), badName).toThrow(
        /snake_case/,
      );
    }
  });

  it('rejects actions whose JSON Schema does not compile', () => {
    const bad = {
      name: 'broken_schema',
      description: 'Broken schema.',
      // Simulates a misbehaving platform definition shipping a schema Ajv cannot compile.
      inputSchema: { type: 'not-a-type' },
      outputSchema: EMPTY_OUTPUT_SCHEMA,
      effects: 'read' as const,
    };

    expect(() => makeExecutor({ actions: [...DOCS_ACTIONS, bad] })).toThrow(
      /Invalid input schema for action "broken_schema"/,
    );
  });

  it('rejects an action with an unknown effects value (T10)', () => {
    const bad = {
      name: 'delete_doc',
      description: 'An effects value outside the vocabulary.',
      inputSchema: EMPTY_INPUT_SCHEMA,
      outputSchema: EMPTY_OUTPUT_SCHEMA,
      effects: 'obliterate',
    };

    expect(() => makeExecutor({ actions: [...DOCS_ACTIONS, bad] })).toThrow(
      /Invalid effects "obliterate" for action "delete_doc"/,
    );
  });

  it('rejects duplicate connection records', () => {
    expect(() => makeExecutor({ connections: [CONN_1_A, CONN_1_A] })).toThrow(
      /Duplicate connection "conn-1" for tenant "tenant-a"/,
    );
  });

  it('rejects a connection that references an unregistered connector', () => {
    expect(() =>
      makeExecutor({ connections: [{ ...CONN_1_A, connectorId: 'ghost' }] }),
    ).toThrow(/Connector "ghost" is not registered/);
  });
});
