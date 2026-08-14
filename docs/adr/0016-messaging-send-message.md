# ADR-0016: Messaging joins the catalog — canonical `send_message`, Feishu IM send first

**Status:** Accepted

**Date:** 2026-08-14

## Context

The platform was docs-only by design (v1 spec: Feishu Docs). This ADR
records the boundary expansion: capability families now grow along a
catalog-driven roadmap — the upstream API catalog orders the work, and
every family enters through the existing curated machinery
(canonical/provider-native split, unified schemas and errors, governance),
never as raw passthrough (ADR-0013's no-proxy rule is untouched). The
first family is messaging; the first batch is IM send. Building capability
ahead of consumer demand is accepted as the roadmap philosophy.

Grilling record: 2026-08-14 session.

## Decision

1. **Roadmap:** catalog-driven (IM → contact → calendar → …), curation
   unchanged. Building ahead of demand is accepted.
2. **First batch is send-side only.** Receiving messages requires upstream
   event subscriptions and the ADR-0011 platform event surface — a
   separate platform project, not part of this batch.
3. **One canonical action:** `send_message` (effects: `write`).
   - **Identity:** the connection owner (user access token) — the
     glossary's "actions execute with the identity of the connection's
     owner" holds. A bot/app-identity sender is a future, separately
     decided identity.
   - **Content:** plain text (`content: string`). Rich post and card
     shapes are future separately-curated decisions; cards stay
     non-passthrough.
   - **Addressing:** `{ email?: string, chat_id?: string }`, exactly one.
     Email is the agent's natural key (Feishu receives by email natively);
     `chat_id` stays opaque. Provider tokens (`open_id`/`user_id`/
     `union_id`) never enter the schema.
   - **Output:** `{ message_id }`.
4. **Feishu first; DingTalk second batch.** A canonical action absent from
   a connector's `implements` is a coverage gap (the `export_doc`
   precedent). The schema is designed against concepts both providers
   have.
5. **Scope:** Feishu authorize scopes gain `im:message`. Existing
   connections re-run the Authorize Flow to gain it (re-authorization is
   native to the flow); no migration machinery.
6. **Rate limit:** the Feishu connector stays on the platform default
   (600/min) — a connector-level declaration would throttle the doc
   family too. Revisit after a live pass measures IM's real limits.

## Consequences

- The registry gains its first non-doc canonical action; `Chat` enters the
  glossary (CONTEXT.md); the consumption standard and OpenAPI snapshot
  document the action on landing.
- DingTalk and WeCom messaging send become catalog-roadmap follow-ups.
- Non-doc families now have a worked curation precedent: minimal action
  set, connection-owner identity, natural-key addressing, opaque IDs
  everywhere else.
