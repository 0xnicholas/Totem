# ADR-0008: REST Actions RPC as the execution substrate

**Status:** Accepted

**Date:** 2026-08-10

## Context

Totem's consumption surfaces (decided 2026-08-10): **MCP for agents, REST for non-agent code** (CI, scheduled jobs, backend services of internal projects). T12 shipped the read-only REST discovery surface (`GET /actions`, `POST /actions/search`); the RPC envelope (`POST /actions/rpc`) was deferred until the MCP adapter proved the action envelope in real use — which it has (AC-6 live verification against Feishu, plus the behavior test suite through Seam A).

The failure mode to avoid: a REST surface that drifts from the MCP tool schemas — different param names, different errors, a second semantics. StackOne avoids this by construction (one engine, adapters over it) and its research brief (`docs/research/stackone-protocols.md` §4) concluded totem should do the same: adopt REST Actions RPC as the canonical execution substrate with MCP as an adapter, not as an independent "traditional API".

## Decision

v2 adds `POST /actions/rpc` as a thin HTTP projection of `executeAction` (Seam A):

- **Envelope:** `{ action, args }` — `args` is the same flat object MCP `tools/call` receives for the action (the registry's input schema). StackOne's `{action, path, query, body, headers}` splitting reflects *its* registry's parameter positions; totem's registry has none, so splitting would create exactly the two-surface parameter divergence this ADR prohibits. Auth: tenant API key (Bearer, actions scope). Connection addressing: `x-connection-id` header — the same per-request resolution the MCP adapter already performs.
- **Zero logic of its own:** allowlist check, schema validation, token acquisition, dispatch, audit write all remain in the execution boundary. The REST route is an adapter and nothing else.
- **Identical contracts:** unified error vocabulary with `retryable` (ADR-0005), HTTP status per code (400/401/403/404/429/502), 429 + `Retry-After` (T13), the ADR-0006 list envelope, cursor pagination when it lands.
- **The registry is canonical; REST and MCP are both projections.** No second schema, no second error vocabulary, no divergent parameter naming. Changes land in the registry/executor and both surfaces inherit.
- A2A and SDK toolset surfaces remain out of scope (internal consumers use MCP or REST directly).

## Consequences

- **Positive:** non-agent consumers (CI, jobs, scripts) get a floor without MCP clients; one engine, two adapters — drift is impossible by construction; MCP protocol churn is hedged by a stable REST surface; the work is adapter-sized because the envelope is already proven.
- **Negative:** a second transport means a second auth path to test (shares the tenant key and the T13 per-tenant throttle, both applied at Seam A, so the surface is small); two ways to call actions means documentation must always present both.
