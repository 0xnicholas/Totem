# ADR-0006: Unified list envelope

**Status:** Accepted

**Date:** 2025-08-10

## Context

Several v1 actions return lists of resources: `search_docs` returns `{ docs: [...] }`, `read_bitable_records` returns `{ records: [...] }`, `read_sheet_cells` returns `{ values: [...] }`. StackOne's Falcon research (`docs/research/stackone-connector-engine.md` §2.4, line 177) flags this as a drift risk: once a second connector lands, per-connector list shapes would make pagination and enumeration inconsistent for agents, and would require a platform-wide schema change to fix. Totem's actions are platform-owned (ADR-0001), so the envelope is a platform decision, not a per-connector one — it must be fixed *now*, before the second connector validates the abstraction.

## Decision

Every v1 list action returns **exactly one list field** on its output object, named for the item type it contains, and the platform documents that shape as the stable list convention:

- `search_docs` → `{ docs: [...] }` (items: `doc_id`, `title`, `doc_type`)
- `read_bitable_records` → `{ records: [...] }` (items: `record_id`, `fields`)
- `read_sheet_cells` → `{ values: [...] }` (row-major cell matrix)

The convention, binding on every connector:

1. **A list action's output is a JSON object with exactly one array property** named after the item it contains (`docs`, `records`, `values`, ...), plus any identity fields the caller needs to act on the result (`doc_id`, `range`, ...). There is no bare top-level array, and never more than one array property.
2. **Pagination is explicit and capped**: list actions accept a `limit` (1–100, with a documented default) and return no more than that many items. Cursor pagination (`next`/`next_page_token` on the output) is deferred until an action needs more than 100 items per call; when it lands, it lands on *every* list action at once, as a platform change, not per connector.
3. **Item shape is platform-owned**: connectors map their system shape (Feishu's `docs_entities` etc.) into the platform's fields (ADR-0001). The same action name has identical input/output schemas on every connector.

This deliberately does **not** adopt StackOne's `{data, next}` envelope verbatim: totem's list actions carry identity fields alongside the list, and renaming the v1 fields would churn every agent-facing schema before the second connector exists. The ADR pins the *convention* — one named list field, capped, platform-shaped — which is the drift protection the research asks for.

## Consequences

- **Positive:** agents enumerate and cap uniformly across actions and future connectors; a future `next` cursor field becomes an additive schema change on all list outputs at once; connector authors have one list pattern to copy.
- **Negative:** a `{data, next}`-shaped caller expecting StackOne-style envelopes must adapt (totem's own MCP adapter normalizes the action output as-is, so agents see the totem shape directly); multiple array properties in one output would violate the convention and must be reviewed at registry time.
