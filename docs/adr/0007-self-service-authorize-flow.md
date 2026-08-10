# ADR-0007: Self-service authorize flow

**Status:** Accepted

**Date:** 2026-08-10

## Context

v1 connections are operator-configured: the platform operator runs `totemctl set-feishu-creds` with the tenant's app credentials, and the tenant has no self-service path. That is fine at one connector and a handful of tenants, but every new connection and every re-auth depends on the operator.

Totem's trajectory (decided 2026-08-10): an **internal platform** whose consumers are the operator's own internal projects — not a SaaS, no external customers, no second-level customer. StackOne's self-serve linking machinery (connect sessions, embedded Hub, auth links, `origin_owner_id` trust rules) exists precisely for the SaaS model it rejected here: external customers linking accounts against platform-managed OAuth apps. Copying it would add session tokens, a Hub UI, and owner-identity rules for a consumer set that needs none of them.

Keeping operator-configured connections does not scale either: the operator becomes the bottleneck for the most common operation in the system's life (adding a connection).

## Decision

v2 connection provisioning is the **self-service minimal OAuth flow** (the Authorize Flow):

1. **Tenants register their own App Credentials** (v1: a Feishu custom app, `app_id`/`app_secret`) via the admin API — self-service, no operator ticket. Credentials are held and encrypted by the platform (per-tenant apps remain: the production-correct choice for branding and dedicated rate limits).
2. **The platform runs the OAuth dance**: it returns an authorize URL; the tenant's user grants access in the system's consent screen; the callback creates the Connection.
3. **No connect session, no Hub, no `origin_owner_id`, no session token — one redirect.** The tenant is authenticated by its API key at the admin surface; there is no client-supplied identity to trust.
4. **Exactly one canonical redirect URI per deployment**, registered in the app config and recorded on the connection so re-auth never breaks.
5. The v1 operator path stays as a fallback for systems without self-service app registration.

## Consequences

- **Positive:** new connections and re-auth stop depending on the operator; no Hub/connect-session machinery to build or maintain; token custody stays in the platform; the model is a strict simplification of StackOne's (deliberately).
- **Negative:** the flow is interactive — a user must grant in the consent screen, so headless/bot connections need the token path later; tenants must be able to create their own OAuth apps in each system (a real precondition for some internal systems); the authorize flow is v2 work — v1 remains operator-configured by design.
