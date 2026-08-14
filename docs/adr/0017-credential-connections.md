# ADR-0017: Connections come in two kinds — user-grant and credential

**Status:** Accepted

**Date:** 2026-08-14

## Context

ADR-0015 asserted that "connector #3 contributes two thin adapter files" —
the universal-OAuth assumption. WeCom messaging send (ADR-0016, third
batch) falsifies it: WeCom self-built apps have no user OAuth at all — no
consent screen, no user tokens, no refresh tokens. The access token is
corpid+secret via gettoken (7200s, refetched on expiry), and the
connection's identity is the app itself. The WeCom docs connector was
rejected for value (#46), but messaging send inherits the same credential
model, so the platform still needs this form.

## Decision

1. **Two connection kinds.**
   - **user-grant**: created by the Authorize Flow (consent + callback);
     tokens are the grant's; identity = the connection's owner. Feishu,
     DingTalk.
   - **credential**: created when the tenant registers App Credentials
     (admin API — no authorize URL, no callback, no state machine);
     token = the app-level access token served by the cached cell
     (`createCachedTokenProvider`: fetch on miss/expiry, single-flight,
     never marks auth-expired). Identity = the app. WeCom.
2. **No new state machine.** Credential connections skip the Authorize
   Flow entirely; the creds-registration endpoint creates the connection.
3. **Token seam unchanged.** The executor still sees ADR-0004's
   `TokenProvider.getValidAccessToken`; routing selects the cached cell
   for credential connections.
4. **Governance unchanged.** Allowlist, audit, and Defender treat both
   kinds identically.
5. **ADR-0015 amended in one clause**: "connector #3 contributes thin
   adapters" holds for the token adapter, not for connection creation —
   the creation path is kind-dependent, and only user-grant providers
   contribute a flow adapter.
6. **Code lands with the WeCom messaging batch** — no connector consumes
   the form before it.

## Consequences

- CONTEXT.md gains **Credential Connection**; `Connection`, `App
  Credentials`, and `Authorize Flow` are amended to cover both kinds.
- A platform prerequisite issue tracks the implementation (creds
  registration creates the connection, cached-cell routing, `wecom-creds`
  admin endpoint).
- `test_connection` for credential connections is the token-acquisition
  proof — there is no harmless upstream probe.
