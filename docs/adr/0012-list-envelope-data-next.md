# ADR-0012: List actions return the StackOne `{data, next}` envelope

**Status:** Accepted

**Date:** 2026-08-10

## Context

ADR-0006 (2025-08-10) pinned a "named list field" convention (`docs` /
`records` / `values`) and deliberately rejected StackOne's `{data, next}`
envelope, fearing agent-facing schema churn before the second connector
existed. The consumption-standard work (2026-08-10) aligned totem's public
contract with StackOne's published contract (`docs/standards/
consumption-standard.md`) so consumers can adjust against a known standard —
and the list envelope was the one place the standard contradicted the
implementation. Grilling decision 2026-08-10: full alignment. v1 still has
no real consumers, so the renaming churn ADR-0006 feared is currently free —
the only window to lock the standard in without breaking anyone.

## Decision

Every list action returns `{data, next}`:

- `data` — the item array; item shape stays platform-owned (ADR-0001),
  e.g. `doc_id`/`title`/`doc_type`;
- `next` — the cursor. v1 stance (superseded 2026-08-14, #42 / tracking
  #50): always `null`. Cursor semantics have since landed for the list
  actions that have them (`search_docs`, `feishu_read_bitable_records`):
  a non-null token when more results exist, passed back as the optional
  `page_token` input; providers without cursor support keep `null`
  (single page). Still additive: `data` and the top-level identity fields
  never changed shape.
- identity fields the caller needs to act on the result (`doc_id`, `range`,
  `table_name`) stay at the top level beside `data`/`next` — preserving
  ADR-0006's original intent that callers get the object handle they acted
  on.

ADR-0006 is superseded. Affected v1 actions: `search_docs`,
`read_sheet_cells`, `read_bitable_records`.

## Consequences

- **Positive:** the wire contract matches the consumption standard and
  StackOne's `actionType: list`; cursor pagination lands additively (no
  shape change ever); agents enumerate uniformly across actions and future
  connectors.
- **Negative:** the three list outputs are renamed — free now (no
  consumers), a breaking change from the moment v1 has any.
- The shape is recorded in the standard §7 and CONTEXT.md (`List Envelope`).
