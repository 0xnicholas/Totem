# ADR-0020: `send_message` gains a canonical `format` field — WeCom markdown first

**Status:** Accepted

**Date:** 2026-08-25

## Context

ADR-0016 Decision 3 deferred non-text message content as a "future
separately-curated decision"; the WeCom connector landed (#47) with the
same deferral recorded inline. Issue #59 is that decision, taken after a
2026-08-25 grilling session on the WeCom connector roadmap.

## Decision

1. **One canonical optional field:** `send_message` input gains
   `format: 'text' | 'markdown'`. Canonical rule holds — identical schema
   on every connector, so the field lands on all three at once. Absent
   means `text`; behavior without `format` is byte-identical to before.
2. **WeCom implements markdown:** both send paths (`message/send` user
   path, `appchat/send` chat path — both support `msgtype: markdown` per
   the official docs) send the content verbatim as a `markdown` body. The
   connector stays a pure translator (ADR-0003): no platform-side markdown
   parsing, no validation of the upstream subset.
3. **Feishu/DingTalk reject explicitly until their batches:** receiving
   `format=markdown` throws `validation_error` before any upstream call,
   with an agent-fixable message (resend without `format`). This follows
   the consumption standard §11.4 input rule (an optional parameter the
   provider cannot honor is a validation error) — the same rule the
   DingTalk connector already applies to email addressing.
4. **The supported subset is documented, not enforced:** the action
   description and consumption standard §11.5 declare that WeCom renders
   an upstream markdown subset (content ≤ 2048 bytes); what the subset
   renders is upstream's behavior, pinned by the live pass (#57), not by
   platform code.

## Considered Options

- **Provider-native first** (`wecom_send_markdown`, promoted later per
  ADR-0014): rejected — markdown is not a provider-specific capability;
  all three providers have a markdown-ish rendering, so a transitional
  native action would only buy a deprecation cycle.
- **Content sniffing** (connector auto-detects markdown): rejected —
  non-deterministic translation breaks the pure-translator honesty rule.
- **Fail-closed subset validation at the boundary:** rejected — means
  owning a markdown parser against three different dialects, when
  upstream renders unsupported syntax without erroring; documentation
  carries the subset instead.

## Consequences

- ADR-0016 Decision 3's content clause ("plain text; rich shapes are
  future decisions") is now partially taken: `format` covers markdown;
  cards stay future and non-passthrough (parking lot, recorded in #61).
- Feishu/DingTalk markdown rendering become catalog-roadmap follow-ups;
  their interim `validation_error` rejection narrows ADR-0005's
  "connectors never emit orchestration-level codes" line in practice
  (§11.4 is the later, more specific rule — ADR-0005's wording is stale
  relative to in-repo practice).
- `recall_message` (#60) and mentions (#61) are the next messaging-family
  decisions; both were direction-settled in the same grilling session.
