# ADR-0005: Unified error vocabulary

**Status:** Accepted

**Date:** 2025-08-09

## Context

Agents must be able to act on errors: retry when retrying helps, stop when it cannot. Without a shared error contract, each connector invents its own failure shapes and agents learn per-system error folklore — the same fragmentation the action layer exists to eliminate. The error vocabulary is part of the action layer's interface and must be stable.

## Decision

Exactly seven error codes in v1, each with a `retryable` flag:

| code              | meaning                                  | retryable |
|-------------------|------------------------------------------|-----------|
| `validation_error`| input failed action schema validation    | false     |
| `action_not_found`| unknown action name                      | false     |
| `forbidden`       | allowlist rejection (defense in depth)   | false     |
| `auth_expired`    | token invalid; needs re-authorization    | false     |
| `not_found`       | upstream resource missing (doc deleted)  | false     |
| `rate_limited`    | upstream rate limit (Feishu)             | true      |
| `upstream_error`  | any other upstream failure               | false     |

Error shape:

```typescript
interface ActionError {
  code: ErrorCode
  message: string
  retryable: boolean
  upstream?: { code: string; message: string }  // original upstream error, for diagnostics
}
```

**Code ownership is split by layer:**

- Orchestration layer owns: `validation_error`, `action_not_found`, `forbidden`.
- Connector layer owns: `not_found`, `rate_limited`, `upstream_error` — plus signalling `auth_expired` for token failure (though in practice refresh failure is caught at the orchestration layer per ADR-0004).
- A connector may never emit orchestration-level codes.

**Consequences**

- **Positive:** agents get one stable decision table; `retryable` eliminates futile retry loops; `upstream` preserves diagnostic traceability to Feishu error codes.
- **Negative:** error mapping is real work per connector (Feishu's error codes must be classified into the seven buckets); adding a code later is an interface change that touches the vocabulary everywhere.
