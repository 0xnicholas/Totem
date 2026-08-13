import Ajv, { type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import type { AnySchemaObject } from 'ajv';
import type { Action, ActionEffect, ProviderToken } from './action.js';
import { PROVIDER_TOKENS } from './action.js';
import type { IConnector } from './connector.js';
import type { ValidationIssue } from './errors.js';
import { errorMessage } from './errors.js';

/** Action names follow the spec's verb_noun snake_case convention, e.g. `create_doc`. */
const ACTION_NAME_PATTERN = /^[a-z][a-z0-9]*(?:_[a-z][a-z0-9]*)+$/;

const ACTION_EFFECTS: readonly ActionEffect[] = ['read', 'write', 'destructive'];

interface RegisteredAction {
  action: Action;
  validateInput: ValidateFunction;
  validateOutput: ValidateFunction;
}

/**
 * Schema-first action registry — the platform-owned single source of truth
 * for every action (ADR-0001): name, agent-facing description, input/output
 * JSON Schemas. Connectors declare which actions they implement via their
 * manifest; they never register actions themselves.
 *
 * Schemas are pre-compiled at registration, so validation failures are
 * impossible at execution time. MCP exposure is a thin adapter over this
 * registry — no action logic lives outside it.
 */
export class ActionRegistry {
  private readonly ajv: Ajv;
  private readonly actions = new Map<string, RegisteredAction>();
  private readonly connectors = new Map<string, IConnector>();

  constructor() {
    this.ajv = new Ajv({ allErrors: true });
    addFormats(this.ajv);
  }

  /** Registers a platform action definition (name, description, schemas). */
  registerAction(action: Action): void {
    if (!ACTION_NAME_PATTERN.test(action.name)) {
      throw new Error(
        `Invalid action name "${action.name}": action names must be lowercase snake_case ` +
          `with a verb_noun shape (e.g. create_doc)`,
      );
    }
    if (!ACTION_EFFECTS.includes(action.effects)) {
      throw new Error(
        `Invalid effects "${action.effects}" for action "${action.name}": ` +
          `must be one of ${ACTION_EFFECTS.join(', ')}`,
      );
    }
    this.assertProviderScope(action.name, action.provider);
    if (this.actions.has(action.name)) {
      throw new Error(`Action "${action.name}" is already registered`);
    }
    this.actions.set(action.name, {
      action,
      validateInput: this.compile(action.name, action.inputSchema, 'input'),
      validateOutput: this.compile(action.name, action.outputSchema, 'output'),
    });
  }

  /**
   * The ADR-0013 scope rules, enforced at registration (fail fast, never at
   * runtime): the provider token must be in the closed union; a
   * provider-native name must carry the `<provider>_` prefix; a canonical
   * name must not carry any known provider prefix.
   */
  private assertProviderScope(name: string, provider: ProviderToken | undefined): void {
    if (provider !== undefined && !PROVIDER_TOKENS.includes(provider)) {
      throw new Error(
        `Invalid provider "${provider}" for action "${name}": ` +
          `must be one of ${PROVIDER_TOKENS.join(', ')}`,
      );
    }
    if (provider !== undefined) {
      if (!name.startsWith(`${provider}_`)) {
        throw new Error(
          `Provider-native action "${name}" must start with "${provider}_" (ADR-0013)`,
        );
      }
      return;
    }
    for (const token of PROVIDER_TOKENS) {
      if (name.startsWith(`${token}_`)) {
        throw new Error(
          `Canonical action "${name}" must not carry the "${token}_" provider prefix (ADR-0013)`,
        );
      }
    }
  }

  /**
   * Registers a connector and validates its manifest: every action name in
   * `implements` must exist in the registry, the manifest must declare a
   * known provider token, and a provider-native action may appear only in
   * the `implements` list of connectors of the same provider (ADR-0013).
   */
  registerConnector(connector: IConnector): void {
    if (this.connectors.has(connector.manifest.id)) {
      throw new Error(`Connector "${connector.manifest.id}" is already registered`);
    }
    // Cast: the manifest type declares `provider` required, but registration
    // is a runtime boundary — a hand-built manifest may omit it, and the
    // closed union (ADR-0013) is enforced here, not only by the compiler.
    const provider = connector.manifest.provider as ProviderToken | undefined;
    if (provider === undefined || !PROVIDER_TOKENS.includes(provider)) {
      throw new Error(
        provider === undefined
          ? `Connector "${connector.manifest.id}" must declare a provider ` +
              `(one of ${PROVIDER_TOKENS.join(', ')})`
          : `Invalid provider "${provider}" for connector "${connector.manifest.id}": ` +
              `must be one of ${PROVIDER_TOKENS.join(', ')}`,
      );
    }
    for (const actionName of connector.manifest.implements) {
      const registered = this.actions.get(actionName);
      if (!registered) {
        throw new Error(
          `Connector "${connector.manifest.id}" implements unknown action "${actionName}"`,
        );
      }
      const actionProvider = registered.action.provider;
      if (actionProvider !== undefined && actionProvider !== provider) {
        throw new Error(
          `Connector "${connector.manifest.id}" (provider "${provider}") cannot implement ` +
            `provider-native action "${actionName}" (provider "${actionProvider}")`,
        );
      }
    }
    this.connectors.set(connector.manifest.id, connector);
  }

  getAction(name: string): Action | undefined {
    return this.actions.get(name)?.action;
  }

  getConnector(id: string): IConnector | undefined {
    return this.connectors.get(id);
  }

  /** All registered platform actions, in registration order. */
  listActions(): Action[] {
    return [...this.actions.values()].map((entry) => entry.action);
  }

  /**
   * Validates `args` against the action's input schema. Returns the list of
   * issues, or `[]` when the value is valid.
   *
   * @throws if the action name is not registered — callers must resolve the
   * action first.
   */
  validateInput(name: string, args: unknown): ValidationIssue[] {
    return this.validate(name, args, 'input');
  }

  /** Validates a handler's output against the action's output schema. */
  validateOutput(name: string, output: unknown): ValidationIssue[] {
    return this.validate(name, output, 'output');
  }

  private compile(name: string, schema: AnySchemaObject, kind: 'input' | 'output'): ValidateFunction {
    try {
      return this.ajv.compile(schema);
    } catch (err) {
      throw new Error(`Invalid ${kind} schema for action "${name}": ${errorMessage(err)}`);
    }
  }

  private validate(name: string, value: unknown, kind: 'input' | 'output'): ValidationIssue[] {
    const entry = this.actions.get(name);
    if (!entry) throw new Error(`No action "${name}" is registered`);
    const validate = kind === 'input' ? entry.validateInput : entry.validateOutput;
    if (validate(value)) return [];
    return (validate.errors ?? []).map(toIssue);
  }
}

/** Maps an Ajv error to an agent-friendly issue, pointing at the offending property. */
function toIssue(err: {
  instancePath: string;
  keyword: string;
  message?: string;
  params?: unknown;
}): ValidationIssue {
  const params = err.params as
    | { missingProperty?: unknown; additionalProperty?: unknown }
    | undefined;
  let path = err.instancePath || '/';
  if (err.keyword === 'required' && typeof params?.missingProperty === 'string') {
    path = `${err.instancePath}/${params.missingProperty}`;
  } else if (
    err.keyword === 'additionalProperties' &&
    typeof params?.additionalProperty === 'string'
  ) {
    path = `${err.instancePath}/${params.additionalProperty}`;
  }
  return { path, keyword: err.keyword, message: err.message ?? 'Invalid value' };
}
