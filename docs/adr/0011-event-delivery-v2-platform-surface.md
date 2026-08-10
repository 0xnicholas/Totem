# ADR-0011: Event delivery is a platform surface in v2 — v1 consumers subscribe upstream directly

**Status:** Accepted

**Date:** 2026-08-10

## Context

Totem v1 is a pull-only action layer (MCP + REST Actions RPC, ADR-0008). The
StackOne research brief (`docs/research/stackone-governance.md` §4.3, §6.5)
mapped StackOne's webhook delivery — connector events plus platform account
lifecycle events, HMAC-signed with dual-secret rotation — and pre-recorded it
as a v2 item: "Webhooks: v1 has none; when added (v2), adopt StackOne's
contract verbatim", with `connection.created` identified as totem's first
event.

The first consuming project (Emerald) runs an event-driven sync model:
webhook events as the primary path, Celery Beat polling as the safety net.
The platform trajectory is **multiple consuming projects and multiple
connectors** (not just Feishu). Under that trajectory, keeping event
subscriptions consumer-side does not scale: every project would maintain its
own upstream subscriptions, signing, retries, and health per system (N × M
duplication), and the "event → respond" path would sit outside platform
governance and audit entirely.

## Decision

1. **v1 (single consumer, single connector): consumers subscribe upstream
   directly.** Emerald keeps its Feishu event subscription; the webhook
   handler is a bell only (record + enqueue). Every Feishu read/write
   triggered by an event goes through totem actions (REST RPC for Celery
   tasks, MCP for agents); the Celery Beat fallback polls through totem
   actions too. This is the documented onboarding path for event-driven
   projects (integration guide §12).
2. **v2: the platform owns event delivery.** When the first non-Feishu
   connector lands, or a second event-driven consuming project joins
   (whichever comes first), totem implements a webhook delivery surface per
   the pre-recorded contract (research §6.5):
   - **connector events** (the platform provisions the subscription per
     connection downstream) + **platform events** (`connection.created` /
     `updated` / `deleted`);
   - delivery contract: HMAC-SHA256 over the raw body, constant-time
     compare, dual-secret rotation, fast-200 endpoints, retry policy;
   - **double configuration**: a webhook endpoint must exist AND events must
     be enabled per connection/connector — mirroring StackOne's
     "webhook exists AND event enabled on profile" rule;
   - platform events ship first (cheap, platform-produced); connector events
     follow (requires connector subscription support).
3. **Migration is a consumer-side change only.** v1 consumers switch their
   handler from the upstream subscription to the platform webhook; the
   execution surface (actions) is unchanged. The v1 direct-subscription
   arrangement is explicitly transitional, not a permanent architecture.

## Consequences

- **Positive:** no N×M subscription duplication when multiple projects and
  connectors arrive; event-triggered processing eventually enters the
  platform's audit/governance view; the contract is pre-recorded so v2
  implements without re-research; Emerald is not blocked today.
- **Negative:** v1 consumers carry their own subscription machinery
  (signing, retries, health) for the transitional period; migrating to
  platform delivery is a consumer-side rewrite of the event-ingestion path;
  the webhook surface is real v2 work (subscription management, delivery,
  retries, dead-letter, health).
