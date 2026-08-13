import { describe, expect, it } from 'vitest';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import type { Action } from '../src/action.js';
import { ActionRegistry } from '../src/registry.js';
import { actionMetadataSchema, toActionMetadata } from '../src/rest/action-metadata.js';
import {
  EMPTY_INPUT_SCHEMA,
  EMPTY_OUTPUT_SCHEMA,
  EXPORT_DEPRECATION,
  PLATFORM_ACTIONS,
  makeDeprecatedAction,
} from './fixtures.js';

function hiddenAction(name = 'platform_internal'): Action {
  return {
    name,
    description: 'Platform internal bookkeeping.',
    inputSchema: EMPTY_INPUT_SCHEMA,
    outputSchema: EMPTY_OUTPUT_SCHEMA,
    effects: 'write',
    hidden: true,
  };
}

/**
 * The registry's visible-action projection (CONTEXT.md "Visible Action"):
 * the single home of the hidden rule and the advertised ordering, plus the
 * metadata wire shape's single home (`src/rest/action-metadata.ts`). The
 * consumption surfaces no longer re-derive any of this — they translate
 * `visibleActions()` into their wire formats (ADR-0008), so these rules are
 * tested here, once, at the registry's own interface.
 */
describe('ActionRegistry.visibleActions()', () => {
  it('excludes hidden actions and sorts by name', () => {
    const registry = new ActionRegistry();
    for (const action of [...PLATFORM_ACTIONS, hiddenAction()]) registry.registerAction(action);

    expect(registry.visibleActions().map((a) => a.name)).toEqual(
      PLATFORM_ACTIONS.map((a) => a.name).sort(),
    );
  });

  it('returns the full action shape minus the hidden flag (schemas intact)', () => {
    const registry = new ActionRegistry();
    for (const action of PLATFORM_ACTIONS) registry.registerAction(action);

    const createDoc = registry.visibleActions().find((a) => a.name === 'create_doc')!;
    const original = PLATFORM_ACTIONS.find((a) => a.name === 'create_doc')!;
    // The projection reshapes nothing: same fields, same schema references.
    expect(createDoc).toEqual(original);
    expect(createDoc.inputSchema).toBe(original.inputSchema);
    expect(createDoc.outputSchema).toBe(original.outputSchema);
  });

  it('carries provider and deprecation fields through unshaped', () => {
    const registry = new ActionRegistry();
    const deprecated = makeDeprecatedAction();
    for (const action of [...PLATFORM_ACTIONS, deprecated]) registry.registerAction(action);

    const bitable = registry.visibleActions().find((a) => a.name === 'feishu_read_bitable_records')!;
    expect(bitable.provider).toBe('feishu');
    const legacy = registry.visibleActions().find((a) => a.name === 'legacy_export')!;
    expect(legacy.deprecated).toEqual(EXPORT_DEPRECATION);
  });

  it('listActions keeps every registered action in registration order, hidden included', () => {
    const registry = new ActionRegistry();
    const probe = hiddenAction();
    const actions = [...PLATFORM_ACTIONS, probe];
    for (const action of actions) registry.registerAction(action);

    expect(registry.listActions().map((a) => a.name)).toEqual(actions.map((a) => a.name));
    expect(registry.listActions().at(-1)?.hidden).toBe(true);
  });
});

describe('action metadata wire shape (src/rest/action-metadata.ts)', () => {
  it('projects provider on provider-native actions only', () => {
    for (const action of PLATFORM_ACTIONS) {
      const metadata = toActionMetadata(action);
      if (action.provider !== undefined) {
        expect(metadata).toHaveProperty('provider', action.provider);
      } else {
        expect(metadata).not.toHaveProperty('provider');
      }
    }
  });

  it('projects deprecated when present and omits it when absent', () => {
    expect(toActionMetadata(makeDeprecatedAction()).deprecated).toEqual(EXPORT_DEPRECATION);
    for (const action of PLATFORM_ACTIONS) {
      expect(toActionMetadata(action)).not.toHaveProperty('deprecated');
    }
  });

  it('builder output validates against the published schema (Ajv drift guard)', () => {
    // Formats wired like the registry's own Ajv, so the `date` format on
    // deprecation sunsets is actually checked.
    const ajv = new Ajv({ allErrors: true });
    addFormats(ajv);
    const validate = ajv.compile(actionMetadataSchema);
    for (const action of [...PLATFORM_ACTIONS, makeDeprecatedAction()]) {
      expect(validate(toActionMetadata(action)), action.name).toBe(true);
      expect(validate.errors, action.name).toBeNull();
    }
  });
});
