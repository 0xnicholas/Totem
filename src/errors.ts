/**
 * Unified error vocabulary (ADR-0005): exactly seven codes in v1, each with
 * a `retryable` flag. Agents use this as a decision table — retry when
 * retryable, stop otherwise — so failures are handled uniformly across
 * connectors.
 *
 * Code ownership is split by layer: the orchestration layer emits
 * `validation_error`, `action_not_found` and `forbidden`; connectors emit
 * `not_found`, `rate_limited`, `upstream_error` and signal `auth_expired`.
 */
export const ACTION_ERROR_CODES = [
  'validation_error', // input failed action schema validation (orchestration)
  'action_not_found', // unknown action name (orchestration)
  'forbidden', // allowlist rejection, defense in depth (orchestration)
  'auth_expired', // token invalid; needs re-authorization (connector signals)
  'not_found', // upstream resource missing (connector)
  'rate_limited', // upstream rate limit (connector)
  'upstream_error', // any other upstream failure (connector)
] as const;

export type ActionErrorCode = (typeof ACTION_ERROR_CODES)[number];

const RETRYABLE: Record<ActionErrorCode, boolean> = {
  validation_error: false,
  action_not_found: false,
  forbidden: false,
  auth_expired: false,
  not_found: false,
  rate_limited: true,
  upstream_error: false,
};

/**
 * A single JSON Schema validation failure, mapped from an Ajv error into an
 * agent-friendly shape. `path` follows JSON Pointer convention (`/title`);
 * `required` and `additionalProperties` failures point at the offending
 * property.
 */
export interface ValidationIssue {
  path: string;
  keyword: string;
  message: string;
}

/** JSON wire shape of an `ActionError` (ADR-0005). */
export interface ActionErrorJson {
  code: ActionErrorCode;
  message: string;
  retryable: boolean;
  upstream?: { code: string; message: string };
  details?: unknown;
}

/**
 * Structured error of the action layer (ADR-0005 shape). `Error` subclass so
 * connectors can throw it and the executor can distinguish it from arbitrary
 * failures; `toJSON` keeps the wire shape exactly as the ADR defines it.
 *
 * Extension beyond the ADR shape: `details` carries `ValidationIssue[]` on
 * `validation_error` errors so agents can correct their parameters
 * (spec US-18).
 */
export class ActionError extends Error {
  readonly code: ActionErrorCode;
  readonly retryable: boolean;
  /** Original upstream error, for diagnostics. */
  readonly upstream?: { code: string; message: string };
  readonly details?: unknown;

  constructor(
    code: ActionErrorCode,
    message: string,
    opts?: { details?: unknown; upstream?: { code: string; message: string } },
  ) {
    super(message);
    this.name = 'ActionError';
    this.code = code;
    this.retryable = RETRYABLE[code];
    if (opts?.details !== undefined) this.details = opts.details;
    if (opts?.upstream !== undefined) this.upstream = opts.upstream;
  }

  toJSON(): ActionErrorJson {
    const out: ActionErrorJson = {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
    };
    if (this.details !== undefined) out.details = this.details;
    if (this.upstream !== undefined) out.upstream = this.upstream;
    return out;
  }
}

/** True when a thrown value is a vocabulary error a connector may emit. */
export function isActionError(value: unknown): value is ActionError {
  return value instanceof ActionError;
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
