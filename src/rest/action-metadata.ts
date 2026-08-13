import type { ActionDeprecation, ProviderToken, VisibleAction } from '../action.js';
import { PROVIDER_TOKENS } from '../action.js';

/**
 * The REST wire shape of one visible action on the discovery surface (T12):
 * name, description and effects, plus `provider` on provider-native actions
 * only (ADR-0013) and `deprecated` on deprecated actions only (ADR-0014) —
 * canonical / non-deprecated actions omit the keys, so both are additive
 * and minor.
 *
 * This module is the single home of the shape. `toActionMetadata` builds it
 * from the registry's visible view and `actionMetadataSchema` publishes the
 * same shape as JSON Schema; the discovery surface maps through the builder
 * and the OpenAPI generator embeds the schema by reference. A new advertised
 * registry field therefore lands in `Action`, the registry's
 * `visibleActions()` view, and this module — never in the two surfaces.
 */
export interface ActionMetadata {
  name: string;
  description: string;
  effects: string;
  provider?: ProviderToken;
  deprecated?: ActionDeprecation;
}

/** Projects a visible action to its metadata wire shape. */
export function toActionMetadata(action: VisibleAction): ActionMetadata {
  return {
    name: action.name,
    description: action.description,
    effects: action.effects,
    ...(action.provider !== undefined ? { provider: action.provider } : {}),
    ...(action.deprecated !== undefined ? { deprecated: action.deprecated } : {}),
  };
}

/**
 * The JSON Schema of `ActionMetadata` — the counterpart of
 * `toActionMetadata`, kept beside it so the two can never drift unnoticed
 * (the kernel suite additionally validates builder output against this
 * schema with Ajv). `provider` derives its closed union from
 * `PROVIDER_TOKENS` — never re-listed by hand.
 */
export const actionMetadataSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string' },
    description: { type: 'string' },
    effects: { type: 'string' },
    provider: {
      type: 'string',
      description:
        "The action's provider scope (ADR-0013): present on provider-native " +
        'actions only; canonical actions omit the key.',
      enum: [...PROVIDER_TOKENS],
    },
    deprecated: {
      type: 'object',
      description:
        "The action's deprecation status (ADR-0014): present on " +
        'deprecated actions only; non-deprecated actions omit the key.',
      additionalProperties: false,
      properties: {
        replacement: { type: 'string' },
        sunset: { type: 'string', format: 'date' },
        note: { type: 'string' },
      },
    },
  },
  required: ['name', 'description', 'effects'],
} as const;
