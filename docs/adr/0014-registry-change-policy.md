# ADR-0014: Registry change policy — breaking-change classification, deprecation, coverage-gap signaling

**Status:** Accepted

**Date:** 2026-08-13

## Context

The action registry is the public contract of two consumption surfaces (MCP,
Actions RPC), and it is about to grow: provider-native actions (ADR-0013),
promotion paths, and an expanding canonical set. StackOne's answer to
catalog evolution is per-connector semver with profile pins plus a published
breaking-change classification — but it has **no action-level deprecation
policy**; the pin system is the only safety net (`docs/research/
stackone-unified-models.md` §4). Totem has no pinning (deferred to v2), so a
removal or rename today breaks both consuming projects immediately. The
registry therefore needs its own change policy before the catalog grows:
what is safe, what is breaking, how breaking changes are executed, and how
deprecation and coverage gaps are signaled.

Grilling record: #36 (2026-08-13). The classification table is adopted from
StackOne's connector-versioning table, extended with totem-specific rows.

## Decision

### 1. Change classification

| Class | Change | Consumers |
| --- | --- | --- |
| **Minor (safe)** | New action (canonical or provider-native); new optional input parameter; new optional output field; adding a `deprecated` flag; description/doc edits | No action required |
| **Major (breaking)** | Removing an action; renaming an action; removing or renaming a field; behavioral changes (pagination, filtering, error semantics, default values); changing an action's `effects` class | Requires the execution contract below |

### 2. Execution contract (social, not versioned)

The registry carries no version number and consumers cannot pin. A breaking
change therefore requires: a tracking issue referenced from the PR,
advance notice to both consuming projects, and a migration window agreed
per case and recorded in the issue. Version-pinning infrastructure stays
deferred to v2 (research §5.4 — pin-format vocabulary `latest` / `1.x.x` /
exact is pre-recorded there; `^`/`~` rejected).

### 3. Deprecation

`Action` gains `deprecated?: { replacement?: string; sunset?: string (ISO
date); note?: string }`. Declaring a `replacement` makes `sunset` required.
Both invariants are enforced at registration (T19b): `sunset` must be a
`YYYY-MM-DD` calendar date.

- Until sunset, a deprecated action stays advertised and stays executable —
  hiding it would silently break existing allowlists.
- The MCP adapter prefixes a deprecated tool's description with
  `[DEPRECATED — use <replacement>, sunset <date>]`. This is the sole
  exception to ADR-0013's "descriptions carry no marking": deprecation is
  time-varying state, not identity, and the agent must see it at
  tool-selection time.
- `GET /actions` exposes the structured `deprecated` fields.
- Removal at sunset is a major change and follows the execution contract.

This deliberately exceeds StackOne, which has no action-level deprecation
at all.

### 4. Coverage-gap signaling

- **Output:** an optional output field a provider cannot supply is `null`;
  no error is raised (StackOne's null-for-unsupported convention, research
  §2.2). Recorded in the consumption standard.
- **Input:** an optional input parameter a provider cannot honor is a
  `validation` error at execution — silently ignoring it is forbidden,
  because the agent would otherwise believe the parameter took effect
  (e.g. an ordering hint that wasn't applied). First live case: DingTalk
  `send_message` rejects `email` addressing (#49 — no email→userid lookup
  API exists there; recorded in the consumption standard §11.5).

## Consequences

- **Positive:** consumers get a published stability contract before the
  catalog grows; promotion (ADR-0013) has concrete machinery
  (`replacement` + `sunset`); the deprecation story exceeds StackOne's
  instead of inheriting its gap.
- **Negative:** process weight on every breaking change (issue + notice +
  window); sunset dates must be honored operationally; with no pinning,
  the policy is only as strong as the social contract — acceptable while
  consumers are two mutually-trusted internal projects (ADR-0010).
- The consumption standard (`docs/standards/consumption-standard.md`)
  gains the classification table, the deprecation semantics, and the
  coverage-gap conventions; `GET /actions` grows `provider` and
  `deprecated` metadata fields.
