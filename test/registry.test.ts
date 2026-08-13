import { describe, expect, it } from 'vitest';
import type { Action } from '../src/action.js';
import type { ConnectorManifest, IConnector } from '../src/connector.js';
import { DOCS_ACTIONS } from '../src/index.js';
import { FAKE_CONNECTOR_ID, FakeConnector } from '../src/testing/fake-connector.js';
import {
  CONN_1_A,
  EMPTY_INPUT_SCHEMA,
  EMPTY_OUTPUT_SCHEMA,
  PLATFORM_ACTIONS,
  EXPORT_DEPRECATION,
  makeConnector,
  makeDeprecatedAction,
  makeExecutor,
} from './fixtures.js';

function providerAction(name: string, provider: string | undefined): Action {
  return {
    name,
    description: 'A provider-scope probe.',
    inputSchema: EMPTY_INPUT_SCHEMA,
    outputSchema: EMPTY_OUTPUT_SCHEMA,
    effects: 'read',
    // Deliberately outside the closed union in some cases: the registry,
    // not the type system, is the runtime guard here.
    provider: provider as Action['provider'],
  };
}

describe('action registry (registration contract, ADR-0001/0003)', () => {
  it('registers the platform action set (visible view, name-sorted by the registry)', () => {
    const executor = makeExecutor();

    const names = executor.listVisibleActions().map((a) => a.name).sort();
    expect(names).toEqual([
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
      // Deliberately outside ActionEffect: the registry, not the type
      // system, is the runtime guard here.
      effects: 'obliterate',
    } as unknown as (typeof DOCS_ACTIONS)[number];

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

describe('action registry (deprecation, ADR-0014)', () => {
  it('accepts a deprecation with replacement and sunset', () => {
    const deprecated = makeDeprecatedAction();
    const executor = makeExecutor({ actions: [...PLATFORM_ACTIONS, deprecated] });

    const registered = executor.listVisibleActions().find((a) => a.name === 'legacy_export');
    expect(registered?.deprecated).toEqual(EXPORT_DEPRECATION);
  });

  it('accepts marker-only variants (sunset without replacement, note without either)', () => {
    for (const deprecated of [
      { sunset: '2026-09-01' },
      { note: 'Prefer export_doc; removal per the execution contract (ADR-0014 §2).' },
    ]) {
      const executor = makeExecutor({
        actions: [...PLATFORM_ACTIONS, makeDeprecatedAction({ deprecated })],
      });
      const registered = executor.listVisibleActions().find((a) => a.name === 'legacy_export');
      expect(registered?.deprecated).toEqual(deprecated);
    }
  });

  it('accepts a deprecation whose replacement is not yet registered (no referential-integrity check)', () => {
    // Spec story 18: deprecation may precede the successor's landing, so
    // the registry must not require the replacement action to exist.
    const deprecated = makeDeprecatedAction({
      deprecated: { replacement: 'export_doc_v2', sunset: '2026-10-01' },
    });
    const executor = makeExecutor({ actions: [...PLATFORM_ACTIONS, deprecated] });

    const registered = executor.listVisibleActions().find((a) => a.name === 'legacy_export');
    expect(registered?.deprecated?.replacement).toBe('export_doc_v2');
    expect(executor.listVisibleActions().map((a) => a.name)).not.toContain('export_doc_v2');
  });

  it('rejects a replacement without a sunset', () => {
    const bad = makeDeprecatedAction({ deprecated: { replacement: 'export_doc' } });

    expect(() => makeExecutor({ actions: [...DOCS_ACTIONS, bad] })).toThrow(
      /Deprecated action "legacy_export" declares a replacement without a sunset \(ADR-0014\)/,
    );
  });

  it('rejects a sunset that is not an ISO calendar date', () => {
    for (const sunset of ['soon', '2026-13-01', '2026-02-31', '2026-9-1']) {
      const bad = makeDeprecatedAction({ deprecated: { sunset } });
      expect(() => makeExecutor({ actions: [...DOCS_ACTIONS, bad] }), sunset).toThrow(
        /not an ISO calendar date/,
      );
    }
  });
});

describe('action registry (provider scope, ADR-0013)', () => {
  it('accepts a provider-native action whose name carries the <provider>_ prefix', () => {
    const native = providerAction('feishu_probe_thing', 'feishu');
    const executor = makeExecutor({ actions: [...PLATFORM_ACTIONS, native] });

    const registered = executor.listVisibleActions().find((a) => a.name === 'feishu_probe_thing');
    expect(registered?.provider).toBe('feishu');
  });

  it('rejects a provider-native action whose name lacks the <provider>_ prefix', () => {
    const unprefixed = providerAction('probe_thing', 'feishu');
    const wrongProvider = providerAction('dingtalk_probe_thing', 'feishu');

    for (const bad of [unprefixed, wrongProvider]) {
      expect(() => makeExecutor({ actions: [...DOCS_ACTIONS, bad] }), bad.name).toThrow(
        /must start with "feishu_"/,
      );
    }
  });

  it('rejects a canonical action whose name carries a known provider prefix', () => {
    for (const name of ['feishu_probe_thing', 'dingtalk_probe_thing']) {
      const bad = providerAction(name, undefined);
      expect(() => makeExecutor({ actions: [...DOCS_ACTIONS, bad] }), name).toThrow(
        /provider prefix/,
      );
    }
  });

  it('accepts a canonical action whose bare name has no provider prefix', () => {
    const canonical = providerAction('probe_thing', undefined);
    const executor = makeExecutor({ actions: [...PLATFORM_ACTIONS, canonical] });

    const registered = executor.listVisibleActions().find((a) => a.name === 'probe_thing');
    expect(registered?.provider).toBeUndefined();
  });

  it('rejects an action whose provider token is outside the closed union', () => {
    const bad = providerAction('wechat_probe_thing', 'wechat');

    expect(() => makeExecutor({ actions: [...DOCS_ACTIONS, bad] })).toThrow(
      /Invalid provider "wechat" for action "wechat_probe_thing"/,
    );
  });
});

describe('action registry (provider scope at the connector boundary, ADR-0013)', () => {
  it('accepts a connector implementing a provider-native action of its own provider', () => {
    const native = providerAction('feishu_probe_thing', 'feishu');
    const feishuProbe = makeConnector(
      'feishu_probe',
      ['feishu_probe_thing'],
      { feishu_probe_thing: () => ({ ok: true }) },
      'feishu',
    );

    expect(() =>
      makeExecutor({
        actions: [...PLATFORM_ACTIONS, native],
        connectors: [new FakeConnector(), feishuProbe],
      }),
    ).not.toThrow();
  });

  it("rejects a provider-native action in another provider's implements", () => {
    const dingtalkProbe = makeConnector(
      'dingtalk_probe',
      ['feishu_read_bitable_records'],
      {},
      'dingtalk',
    );

    expect(() =>
      makeExecutor({
        actions: PLATFORM_ACTIONS,
        connectors: [new FakeConnector(), dingtalkProbe],
      }),
    ).toThrow(
      /Connector "dingtalk_probe" \(provider "dingtalk"\) cannot implement provider-native action "feishu_read_bitable_records" \(provider "feishu"\)/,
    );
  });

  it('rejects a connector whose manifest omits a provider', () => {
    const unscoped: IConnector = {
      manifest: { id: 'unscoped_probe', implements: [] } as unknown as ConnectorManifest,
      execute: () => Promise.resolve({}),
    };

    expect(() =>
      makeExecutor({
        actions: PLATFORM_ACTIONS,
        connectors: [new FakeConnector(), unscoped],
      }),
    ).toThrow(/Connector "unscoped_probe" must declare a provider/);
  });

  it('rejects a connector whose provider token is outside the closed union', () => {
    const foreign: IConnector = {
      manifest: { id: 'foreign_probe', implements: [], provider: 'wechat' } as unknown as ConnectorManifest,
      execute: () => Promise.resolve({}),
    };

    expect(() =>
      makeExecutor({
        actions: PLATFORM_ACTIONS,
        connectors: [new FakeConnector(), foreign],
      }),
    ).toThrow(
      /Invalid provider "wechat" for connector "foreign_probe"/,
    );
  });
});
