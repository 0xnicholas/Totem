# ADR-0004: TokenManager is a deep module; connectors never see auth

**Status:** Accepted

**Date:** 2025-08-09

## Context

Every action handler needs a valid Feishu access token. OAuth token lifecycle is subtle: encryption at rest, expiry, refresh racing (two concurrent actions both triggering refresh), refresh-token revocation, and the failure state where the connection needs re-authorization. If this logic is distributed across action handlers, every handler re-implements refresh handling and races are inevitable.

## Decision

- **`TokenProvider` has one method**: `getValidAccessToken(connectionId): Promise<string>`. All OAuth lifecycle behaviour hides behind it:
  - encrypted read from Postgres (per-tenant derived key from `TOTEM_TOKEN_ENC_KEY` master key; KMS and key rotation deferred to v2);
  - **early refresh**: refresh is triggered when remaining validity < 5 minutes (not at expiry), avoiding the race where a token dies mid-call;
  - **single-flight refresh**: concurrent requests share one in-flight refresh promise per connection (`Map<connectionId, Promise>`) — exactly one refresh request hits Feishu;
  - **atomic write-back**: refreshed tokens are persisted under row-level optimistic control so concurrent refreshes cannot overwrite each other;
  - **failure marking**: a revoked/invalid refresh token marks the connection `auth_expired`; subsequent calls fail fast with the `auth_expired` error (ADR-0005) until the user re-authorizes.
- **The orchestration layer (`executeAction`) fetches the token before dispatch and places it in `ActionContext.token`.** Connectors receive an already-valid token and have no knowledge of OAuth, refresh, or expiry. Refresh failure is converted to `auth_expired` at the orchestration layer, before any handler runs.
- Token storage is testable via an internal seam: the token store (Postgres repo) is injectable; tests use an in-memory fake and assert single-flight behaviour (two concurrent calls → one refresh request).

## Consequences

- **Positive:** ten+ action handlers × every call share one deep, tested token path; connectors stay stateless w.r.t. auth; refresh races are impossible by construction.
- **Negative:** the orchestration layer carries one extra hop (token fetch) per call; early refresh means slightly more refresh traffic than strictly necessary (worth it to eliminate mid-call expiry).
