# ADR-0015: The OAuth lifecycle is a platform module; provider dirs are adapters

**Status:** Accepted

**Date:** 2026-08-13

## Context

Two provider families now exist (Feishu, DingTalk), and the OAuth machinery
was duplicated along provider lines:

- `feishu/token-manager.ts` and `dingtalk/token-manager.ts` were deliberate
  mirrors of the refresh lifecycle (early-refresh window, single-flight,
  fail-fast marking, encrypted write-back) — differing only in credential
  types, the refresh call, and error classification.
- `feishu/flow.ts` and `dingtalk/flow.ts` were mirrors of the Authorize Flow
  state machine (state TTL, callback, connection-first-then-tokens
  ordering) — differing only in URL building, the exchange call, and error
  classes.
- The shared halves had no home: the dingtalk module imported `TokenProvider`,
  `ConnectionStateStore`, `FlowError`, `OAuthFlow`, `TokenStore` and the
  crypto helpers **from the feishu module**, while carrying its own copy of
  the implementations. The executor's token seam likewise imported
  `TokenProvider` from `feishu/token-manager.js`.

The T17 spec decision ("parallel shapes until a third connector lands")
was recorded in a code comment. The architecture review of 2026-08-13
reopened it: two adapters already exist, so the seam is real — the
"third connector" trigger was the wrong condition, and the seam was owned
by the wrong module.

## Decision

- **The OAuth lifecycle is a platform module at `src/oauth/`:**
  - `token-lifecycle.ts` — the external seam stays ADR-0004's one-method
    `TokenProvider.getValidAccessToken(connectionId)`. Behind it, two
    composable cells: `createUserTokenProvider` (stored tokens: fail-fast,
    decryption, early refresh, single-flight, encrypted write-back,
    best-effort auth-expired marking) and `createCachedTokenProvider`
    (cache-only app-level tokens, same refresh discipline, never marks).
    The cells are an internal seam: provider profiles inject credentials,
    the token call, and failure classification.
  - `authorize-flow.ts` — the Authorize Flow state machine
    (`createOAuthFlow`), parameterized by a provider profile (creds,
    URL building, code exchange, caller-error classification) plus
    provider identity (connector id, connection name).
  - `token-store.ts` / `connection-state.ts` + their Postgres stores —
    provider-agnostic persistence, moved from the feishu dir.
- **Provider dirs contribute adapters only:** `feishu/tokens.ts` +
  `feishu/flows.ts` and `dingtalk/tokens.ts` + `dingtalk/flows.ts` wire the
  profiles (credential types, endpoint clients from `oauth.ts`, error
  mapping). DingTalk's app-token cell (`getValidAppAccessToken`) is a
  DingTalk-adapter detail — it instantiates the cached cell and is exposed
  to the DingTalk connector alone; the executor never sees it.
- **Crypto moves to `src/crypto.ts`** (used by admin, both creds stores,
  and the lifecycle). The HMAC key-derivation context string
  (`totem:feishu:v1:<tenant>`) is frozen for backward compatibility — it is
  a derivation label, not a provider claim.
- **The executor imports `TokenProvider` from `src/oauth/token-lifecycle.js`**
  — never from a provider dir.
- **Supersedes the T17 parallel-shapes note** in `dingtalk/token-manager.ts`
  (file removed with this refactor).

## Consequences

- **Positive:** the refresh and flow machinery exists once; a bug fixed in
  the kernel is fixed for every provider. Connector #3 contributes two thin
  adapter files instead of copying ~350 lines of lifecycle code. The
  kernel is tested once through a fake profile (`test/oauth/`); per-provider
  suites cover only their classification and endpoint shapes.
- **Negative:** the kernel is parameterized (profiles), which is more
  indirection than a concrete class — provider-specific behavior requires
  reading the adapter to see what the profile injects.

## Rejected alternatives

- **Token-only or flow-only generalization:** leaves the other mirror in
  place; the locality win is halved for the same review cost.
- **Widening `TokenProvider` with `getValidAppAccessToken`:** puts a
  one-adapter concept (DingTalk app tokens) on the platform seam — a
  hypothetical seam per the two-adapter rule.
- **Amending ADR-0004 in place:** ADR-0004 is accepted Feishu-era history;
  a new ADR keeps the timeline legible.
