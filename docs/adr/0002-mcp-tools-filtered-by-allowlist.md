# ADR-0002: MCP tools are filtered by allowlist (hide, don't reject)

**Status:** Accepted

**Date:** 2025-08-09

## Context

The MCP server exposes registry actions as tools to AI agents, authenticated by tenant API keys. Governance (ADR per spec) includes per-connection action allowlists. Two enforcement styles exist: expose all tools and reject disallowed calls at execution time, or expose only allowed tools.

Rejection at call time is defense-in-depth but puts the burden on the agent: it must attempt, fail, and recover. LLM agents are prone to hallucinating tools that "might exist", and each rejection is a wasted round-trip plus a chance for a confused retry loop.

## Decision

- **The MCP tool list for a connection is the intersection of the action registry and that connection's allowlist.** Tools the connection cannot use are not advertised.
- **Execution-time rejection remains** in `executeAction` (structured `forbidden` error, ADR-0005) as defense in depth — a client that hard-calls a disallowed action is still blocked and audited.
- The tool list itself is therefore a contract of "what I can do" — which is the optimal prompt for an agent.

## Consequences

- **Positive:** agents never see tools they cannot use; fewer hallucination/retry loops; the tool listing is a governance signal to the agent.
- **Negative:** the MCP server must resolve the caller's tenant/connection before listing tools (slightly more work in the auth path); a change to the allowlist requires the agent to re-list tools to see the update (inherent to MCP).
