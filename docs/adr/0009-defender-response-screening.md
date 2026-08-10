# ADR-0009: Defender — response screening contract (recorded now, implemented v2)

**Status:** Accepted

**Date:** 2026-08-10

## Context

Feishu Docs is exactly the prompt-injection vector StackOne's Defender targets: documents can be authored by external collaborators and shared into a tenant's workspace, and agent tool responses carrying document content can contain instructions designed to hijack the agent. The vector is real for an internal platform (cross-team and externally-shared docs); the blast radius of a hijacked agent is bounded by the allowlist and tenant-scoped systems, but real (create/rename/move within the tenant's own workspace).

v1 deliberately deferred screening (spec issue #1 out-of-scope list). Research (`docs/research/stackone-governance.md` §5, §6.5) mapped StackOne's Defender onto totem's execution boundary and called it "a priority v2 item, not an optional one". Decided 2026-08-10: implement in v2, record the contract now so v2 implements without re-research. A v1 partial build (pattern scan only, no ML tier) was considered and rejected: a single tier gives false confidence against novel attacks.

## Decision

Response screening lives at the **execution boundary's return path** (Seam A — before the MCP server or REST layer returns tool results to the agent). It is a platform cross-cutting concern; connectors stay pure translators (ADR-0003) and never scan.

**Implementation status (2026-08-10):** implemented in two slices. T15 ships Tier 1 — the signature scan, `{tier: 'pattern'}` metadata on results and audit rows, per-tenant policy (scan on / block opt-in), 1MB size guard, blocking via the `forbidden` code with `details.reason = defender_block`. T16 ships Tier 2 (local ML classification, thresholds, larger guards) against this contract.

1. **Two-tier pipeline:** Tier-1 fast pattern scan (known injection signatures) runs on every response; Tier-2 local ML classification (no external API, no data leaves the platform) runs in parallel on every response.
2. **Observe-first default:** scan metadata (`riskLevel`, `tier2Score`, `detections`) attaches to action results; nothing is blocked until an operator enables blocking. Per-tenant override.
3. **Blocking, when enabled:** high-risk responses return a unified error the agent handles like any other tool error.
4. **Boundary annotations** (wrap sanitized results in boundary tags paired with system-prompt instructions) are deferred until agent-facing value is proven.
5. **Size guards:** skip scanning above configurable size/word limits.
6. **Non-goals:** no training on tenant data; no change to action semantics; no scanning inside connectors.

## Consequences

- **Positive:** v2 has a locked contract — no re-research, no design drift; the execution boundary is the single seam, consistent with ADR-0003's thin connectors; observe-first avoids false-positive breakage of working agents; the pattern tier is a cheap always-on tripwire.
- **Negative:** implementing adds metadata fields to the action result envelope (a schema change to the unified output when it lands); the ML tier adds local compute per response; until v2 lands, doc content reaches agents unscanned (accepted risk, bounded by allowlist).
