# ADR-0021: `send_message` gains canonical `mentions` — WeCom @-mentions first

**Status:** Accepted

**Date:** 2026-08-25

## Context

ADR-0016 settled natural-key addressing (agents supply emails, never
provider tokens); upstream raw mention syntax (`<@userid>`) never enters
the schema. Issue #61 is the mentions decision, direction-settled in the
2026-08-25 WeCom-roadmap grilling session, with the remaining spec points
settled at implementation time. Upstream facts are pinned against the
official docs: `appchat/send` text carries `mentioned_list` (userids plus
the `@all` literal) and inline `<@userid>`; `appchat/send` markdown has
only inline `<@userid>` (WeCom 5.0.6+), no `mentioned_list` and no
documented `@all`; `message/send` (the user path) has no mention mechanism
at all — upstream mentions are group-scoped.

## Decision

1. **One canonical optional field:** `send_message` input gains
   `mentions: string[]` — an array of member **emails**, with the literal
   `'@all'` as an array-entry sentinel meaning "mention everyone". The
   canonical rule holds (ADR-0020 Decision 1): identical schema on every
   connector, landing on all three at once. Absent means no mentions;
   behavior without `mentions` is byte-identical to before.
2. **WeCom implements mentions on the chat path only:** every mention
   email resolves through the existing `get_userid_by_email` two-namespace
   probe (the recipient-addressing path); `@all` passes through
   unresolved. Text sends carry `mentioned_list` (resolved userids and the
   `@all` literal, in mention order); markdown sends append one inline
   `<@userid>` token per resolved mention to the content. The connector
   stays a pure translator (ADR-0003).
3. **Unhonorable combinations reject explicitly** (consumption standard
   §11.4 input rule, the ADR-0020 Decision 3 posture): mentions on the
   user path, `@all` with `format=markdown`, and any mentions on
   Feishu/DingTalk all throw `validation_error` before any upstream call,
   with an agent-fixable message. Feishu (batch email→user_id lookup for
   `at` tags) and DingTalk (mobile-number-based @-addressing;
   email→mobile lookup or explicit rejection) are their own batches.
4. **Atomic resolution:** one unresolvable mention email fails the whole
   send with `not_found` before anything goes out — no partial
   notification, and the output schema is unchanged. The miss surfaces
   through the same `not_found` the probe already throws for an unknown
   recipient email.

## Considered Options

- **`@all` as a separate boolean field:** rejected — two fields to explain
  and a both-set combination to police, when the array entry carries the
  same meaning in one place.
- **Partial send with misses reported in the output:** rejected — silently
  under-notifies unless the agent reads the output, and changes the output
  schema; atomic failure matches the single-recipient miss semantics
  already shipped.
- **Reject mentions+markdown wholesale:** rejected — markdown mention
  support is upstream-documented (inline `<@userid>`); only `@all` is
  unhonorable there, so only that combination rejects.

## Consequences

- ADR-0016 Decision 3's addressing clause extends: emails now address
  mention targets as well as recipients; `@all` is the one non-email
  natural key in the schema.
- Feishu and DingTalk mention batches become catalog-roadmap follow-ups,
  with the same explicit-rejection interim as ADR-0020's markdown.
- WeCom's per-mention probe multiplies `get_userid_by_email` calls (up to
  two per email; the endpoint locks for a day after many errors, so
  resolution is sequential and stops at the first hit) — recorded for the
  live pass to keep honest.
- Markdown mention tokens are content: the appended `<@userid>` suffix
  counts against the same upstream ≤2048-byte budget as the agent's own
  markdown (ADR-0020 Decision 4's "documented, not enforced" posture
  covers the sum — the connector appends verbatim and upstream owns the
  limit).
