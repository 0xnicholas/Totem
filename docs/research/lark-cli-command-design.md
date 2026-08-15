# Research: lark-cli command design vs totem Feishu actions — one-shot comparison

**Scope:** How lark-cli shapes its doc-family + bitable commands, compared side-by-side with totem's Feishu actions (current and roadmap #41–#44), as a one-shot design-reference input. Primary source: `larksuite/cli` at commit [`525a982`](https://github.com/larksuite/cli/tree/525a98270f80693bdaf3c0a6006e9f3f94820851) (shortcuts under [`shortcuts/`](https://github.com/larksuite/cli/tree/525a98270f80693bdaf3c0a6006e9f3f94820851/shortcuts), skills under [`skills/`](https://github.com/larksuite/cli/tree/525a98270f80693bdaf3c0a6006e9f3f94820851/skills)). Totem baseline: [`src/actions.ts`](https://github.com/0xnicholas/totem/blob/main/src/actions.ts), ADRs [0016](https://github.com/0xnicholas/totem/blob/main/docs/adr/0016-messaging-send-message.md), [0005](https://github.com/0xnicholas/totem/blob/main/docs/adr/0005-unified-error-vocabulary.md), [0013](https://github.com/0xnicholas/totem/blob/main/docs/adr/0013-provider-native-actions-in-registry.md), tickets [#41](https://github.com/0xnicholas/totem/issues/41), [#42](https://github.com/0xnicholas/totem/issues/42), [#43](https://github.com/0xnicholas/totem/issues/43), [#44](https://github.com/0xnicholas/totem/issues/44).

---

## 1. The CLI's command model (three layers + per-command metadata)

Every shortcut declares a fixed metadata block — the design unit totem would compare its Action type against ([`shortcuts/common`](https://github.com/larksuite/cli/tree/525a98270f80693bdaf3c0a6006e9f3f94820851/shortcuts/common), e.g. [`shortcuts/doc/docs_fetch.go`](https://github.com/larksuite/cli/blob/525a98270f80693bdaf3c0a6006e9f3f94820851/shortcuts/doc/docs_fetch.go)):

- **Service + Command** (`docs +fetch`), Description, **Risk** (`read`/`write`), **Scopes** (granular, e.g. `docx:document:readonly`, `base:record:read`, `search:docs:read`), **AuthTypes** (`user`/`bot`), Flags, and a **DryRun** function that renders the exact HTTP request (method, path, body) as a preview.

Three layers (README "Three-Layer Command System"): shortcuts (curated ergonomics) → **API commands** (one generated command per OpenAPI method, 2,500+ endpoints) → **raw** (`lark-cli api <method> <path>`). Plus per-domain **affordance** markdown surfaced in `--help` and `schema` output ([`affordance/README.md`](https://github.com/larksuite/cli/blob/525a98270f80693bdaf3c0a6006e9f3f94820851/affordance/README.md)).

## 2. Doc-family: totem actions vs CLI commands

| totem action (shape) | lark-cli equivalent (shape) | Divergence & who decides |
|---|---|---|
| `create_doc` — title, folder_id?, content? | `docs +create` (title/folder/content) | Parity on inputs; CLI accepts URLs/tokens as args, totem opaque IDs — **ADR-0016 decides** (totem stays opaque) |
| `get_doc_content` — doc_id → plain text, markdown-style headings | `docs +fetch --doc <URL\|token> --doc-format xml\|markdown\|im-markdown` (default **xml**: full structure + comment anchors; `--detail` for blocks) | CLI defaults to structure-preserving XML, totem to flat plain text. Not invariant-settled — a curation contrast worth noting: CLI optimizes for round-trip fidelity, totem for agent-readability. ([`docs_fetch_v2.go`](https://github.com/larksuite/cli/blob/525a98270f80693bdaf3c0a6006e9f3f94820851/shortcuts/doc/docs_fetch_v2.go)) |
| `search_docs` — query, limit 1–100 (d50), page_token, `next` (#42) | `docs +search` — query, filter JSON, `--page-token`, `--page-size` (default 15, **max 20**); user-identity only | Both cursor-based — the CLI validates totem's #42 cursor choice; CLI page cap 20 vs totem 100 is a per-surface tuning, not a conflict. ([`docs_search.go`](https://github.com/larksuite/cli/blob/525a98270f80693bdaf3c0a6006e9f3f94820851/shortcuts/doc/docs_search.go)) |
| `get_doc_metadata` — curated {doc_id, title, owner_id, doc_type, edited_at} | `drive +inspect` (full drive file meta) | CLI exposes raw meta; totem's 4-field curation is the platform's invariant answer — curation wins. |
| `append_doc_content` — text append, returns full content (#41 RMW) | `docs +update` (markdown/block updates) | Different granularity; CLI's structured-writing ergonomics are the `feishu_append_blocks` fog on map #45, unchanged. |
| `rename_doc` / `move_doc` | drive API commands (+rename/+move, generated layer) | Parity; CLI accepts human tokens, totem opaque IDs (ADR-0016). |
| `export_doc` (docx\|pdf → artifact_id + url) + `get_export_artifact` (base64 bytes, 10 MiB cap, #43) | `drive +export` + `drive +export-download` (file lands on disk) | **The CLI validates #43's core insight** — even its own surface needs a separate download step after export; it delivers bytes to a filesystem, totem delivers bytes in the protocol. No conflict; confirmation of the two-step pattern. |
| `read_sheet_cells` / `write_sheet_cells` | `sheets +read-data` / `+range-*` / `+batch-update` (plus styles, dropdowns, history, formula-verify) | totem's two canonical cell actions are the deliberate v1 slice; CLI's breadth is catalog-fog material, not a design signal. |

## 3. Bitable: totem actions vs CLI commands

| totem action (shape) | lark-cli equivalent (shape) | Divergence & who decides |
|---|---|---|
| `feishu_read_bitable_records` — doc_id, table_name, limit 1–100, page_token, next (#42) | `base +record-list` — app/table token, view ref, **field projection by ID or name** (repeatable), filter, sort, **offset** pagination; `base +record-search` — full request-body JSON escape hatch (keyword, search_fields, select_fields, filter, sort, limit) | **Pagination divergence**: totem picked cursor (`page_token`, #42); CLI defaults to **offset** (+ global `--page-all`). Feishu's API supports both — a genuine design contrast, already settled on totem's side by #42. CLI's projection/filter/sort/view flags are capabilities totem lacks (gap appendix). CLI's accept-name-or-ID ergonomics match totem's table_name. ([`record_list.go`](https://github.com/larksuite/cli/blob/525a98270f80693bdaf3c0a6006e9f3f94820851/shortcuts/base/record_list.go), [`record_search.go`](https://github.com/larksuite/cli/blob/525a98270f80693bdaf3c0a6006e9f3f94820851/shortcuts/base/record_search.go)) |
| `feishu_write_bitable_records` / `feishu_update_bitable_records` | `base +record-batch-create` / `+record-batch-update` / `+record-upsert` | **Upsert** exists CLI-side, not in totem — gap appendix. |
| — | `+record-get`, `+record-query`, `+record-history-list`, `+record-delete`, `+record-export`, `+record-upload-attachment`, `+record-share-link-create`, `+record-markdown` | Breadth beyond totem's read/write/update trio — gap appendix; `record-delete` is #44's destructive-family sibling. |

## 4. Cross-cutting: envelope, errors, IDs, governance

- **Envelope/errors:** CLI: `{ok, identity, data, meta}` success on stdout; typed error taxonomy `{type, subtype, code, message, hint}` on stderr with category-derived exit codes (see lark-cli-runtime-facts.md §3). totem: flat curated outputs + the ADR-0005 unified vocabulary (`not_found`, `rate_limited`, `upstream_error`). **ADR-0005 decides** totem's side; the CLI's subtype taxonomy + agent-directed `hint` field is the richer reference if totem ever deepens its vocabulary — its simplicity is deliberate today.
- **IDs:** CLI accepts human URLs/tokens at every arg boundary (`--doc "document URL or token"`); totem is opaque-only. **ADR-0016 decides** — and the CLI's ubiquity of human-shaped handles documents the *pressure* ADR-0016 resists, which is itself useful context.
- **Governance:** CLI ships per-command risk tiers (`read`/`write`/`high-risk-write`) enforced by a YAML policy engine (max-risk rules, denial) plus `--dry-run` on side-effect commands ([`internal/cmdpolicy/`](https://github.com/larksuite/cli/tree/525a98270f80693bdaf3c0a6006e9f3f94820851/internal/cmdpolicy)). totem: allowlist + Defender at the Execution Boundary. Independent parallel designs that **validate totem's per-action governance concept from an official first-party direction**.
- **Destructive conventions — direct #44 input:** every destructive shortcut (`drive +delete`, `base record_delete`, `wiki +node-delete`/`+delete-space`) carries a risk tier gated by policy, and `--dry-run` renders the exact HTTP request before execution. That exact-request preview + tiered-risk model is concrete design-reference material for #44's governance-semantics design alongside ADR-0018: a delete's dry-run shows the precise upstream call an agent is about to authorize.
- **Skills coverage (context only, no positioning analysis):** 26 skill dirs — approval, apps, attendance, base, calendar, contact, doc, drive, event, im, mail, markdown, minutes, note, okr, openapi-explorer, shared, sheets, skill-maker, slides, task, vc, vc-agent, whiteboard, wiki, workflow-meeting-summary, workflow-standup-report ([`skills/`](https://github.com/larksuite/cli/tree/525a98270f80693bdaf3c0a6006e9f3f94820851/skills)). Domains totem has no connector for: approval, attendance, calendar, contact, mail, minutes, note, okr, task, vc.

## 5. Gap appendix — catalog ideas surfaced by the comparison (routing undecided)

1. **Bitable read enrichment** — field projection, filter, sort, view params for `feishu_read_bitable_records` (a Major-contract-window change per ADR-0014, not a minor).
2. **Bitable upsert** — `feishu_upsert_bitable_records` (provider-native) or a canonical upsert.
3. **Bitable record export / history** — no totem equivalent.
4. **Drive file download generalization** — `get_export_artifact` covers export artifacts only; CLI's `drive +download` suggests a general canonical download (any drive file) as a future question.
5. **Doc history** (`+history-list` / `+history-revert`) — no totem equivalent.
6. **Doc media** (`+media-upload`/`+media-insert`) — `append_doc_content` is text-only.
7. **Wiki node CRUD** — `search_docs` returns wiki results, but no wiki-specific actions.

## 6. Answer gist (ticket #53)

The CLI's curation **validates totem's core choices from an official first-party direction** — opaque IDs (it leans on human tokens, confirming the pressure ADR-0016 resists), curated outputs, per-action risk governance, and the two-step export-then-download pattern (#43). Its concrete divergences: pagination (offset vs #42's cursor — already settled), fetch formats (structure-preserving XML default vs totem's flat text — curation contrast), and capability breadth totem lacks (projection/filter/sort, upsert, history, media). Its destructive conventions — tiered risk + `--dry-run` exact-request preview — are direct design-reference material for #44 alongside ADR-0018.
