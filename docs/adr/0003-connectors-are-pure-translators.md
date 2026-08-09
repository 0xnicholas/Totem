# ADR-0003: Connectors are pure translators

**Status:** Accepted

**Date:** 2025-08-09

## Context

The connector is the module that bridges the unified action layer and a real system (Feishu Docs in v1). Its shape determines how much behaviour lives in the orchestration layer versus the connector, and how hard v2 connectors are to write.

Two failure modes to avoid: a shallow connector interface with one method per action (interface as wide as the implementation, no leverage), and a "fat" connector that reaches into the database, governance, or configuration (duplicates orchestration logic per connector, splits locality of the governance rules).

## Decision

- **Connector interface is thin**: `manifest` (with `implements`) plus `execute(action, args, ctx): Promise<unknown>`. `listActions` derives from the manifest — not a separate method.
- **The connector is a pure translator**: it maps unified args → system request, system response → unified output, and system errors → the unified error vocabulary. It does not touch the database, audit, allowlists, or config stores.
- **`ActionContext` carries exactly three things**: `tenantId`, `connectionId`, and `token` (an already-valid access token, fetched by the orchestration layer — see ADR-0004).
- **Action dispatch inside the connector is an internal seam**: `handlers: Record<actionName, Handler>` — private to the connector, not part of its interface.
- Governance (allowlist check, audit write, schema validation, error mapping of orchestration-level codes) lives entirely in the `executeAction` orchestration layer.

## Consequences

- **Positive:** governance changes touch one place; v2 connector authors learn one interface + one ctx; connectors are trivially fakeable at Seam A (test double implements the same thin interface).
- **Negative:** orchestration layer carries the cross-cutting concerns (by design); connector authors must map into the platform vocabulary rather than exposing system quirks.
