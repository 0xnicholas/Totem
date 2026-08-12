# Research: StackOne Unified Models — Provider Coverage Gaps and Catalog Evolution

Ticket: [#35](https://github.com/0xnicholas/totem/issues/35) · Map: [#34](https://github.com/0xnicholas/totem/issues/34)
Sources: docs.stackone.com (llms.txt index), api.stackone.com OpenAPI — primary only. StackOne is a vendor; positioning claims are flagged as promotional.

## Summary

StackOne's answer to "one canonical model vs provider-specific capability" has visibly shifted since round 1: the Falcon action catalog is the primary surface, and within it the `actionType` property is the dual-structure mechanism — **unified types** (`list`/`get`/`create`/`update`/`delete`) enforce normalized response envelopes across providers, while **`custom`** actions expose provider-specific endpoints with raw provider responses, in the same catalog, tagged with the same categories. The legacy unified REST APIs (HRIS/ATS canonical models) still exist but are being repositioned as secondary ("Same data, optimized for LLM tool calling" points agent builders to the action surface), their custom-field docs now live under `/legacy-unified-apis/` paths, and the raw `POST /unified/proxy` escape hatch is **deprecated**. Coverage gaps are handled out-of-band (a Field Coverage dashboard matrix + null-for-unsupported optional fields) rather than in runtime metadata. Evolution is per-connector semver with connector-profile pins (`latest` / `1.x.x` / exact), an explicit breaking-change classification, and immutable-by-default publishing — but **no action-level deprecation policy exists**.

For totem's live decision (Feishu bitable, DingTalk-only features): StackOne's pattern says provider-specific capabilities enter as **provider-scoped `custom` actions in the same catalog**, not by stretching the canonical model and not by raw passthrough.

## 1. Dual structure — unified actions and provider-native actions in one catalog

### 1.1 `actionType` is the mechanism

Every Falcon action declares an `actionType` that fixes its response envelope ([Connector YAML Reference](https://docs.stackone.com/guides/connector-engine/connector-yaml-reference.md)):

| Type | Description | Response schema |
| --- | --- | --- |
| `custom` | Provider-specific action | Raw provider response |
| `list` | Paginated list (unified) | `{ data: [], next: string }` |
| `get` | Single record (unified) | `{ data: object }` |
| `create` | Create record (unified) | `{ data: object }` |
| `update` | Update record (unified) | `{ data: object }` |
| `delete` | Delete record (unified) | `{ success: boolean }` |
| `refresh_token` | Token refresh (internal) | Credential object |

The reference is explicit about the split ([same page](https://docs.stackone.com/guides/connector-engine/connector-yaml-reference.md)):

- **Unified types** "enforce consistent response schemas across providers, enable cross-provider compatibility, support automatic pagination handling, normalize error responses."
- **`custom`** "returns raw provider response; use for provider-specific features; no schema normalization; full flexibility for unique endpoints."

So the catalog is one flat list per connector where unified-typed and custom-typed actions coexist; "when to expose a native action" is answered with: whenever the capability is provider-specific, type it `custom` and keep it in the catalog.

### 1.2 Categories and internal actions

Actions carry `categories` (e.g. `hris`, `ats`) used for filtering; an action can belong to several. `categories: [internal]` hides an action from UI listings and MCP `tools/list` while keeping it executable via direct API calls — used for token refresh and internal operations ([Connector YAML Reference](https://docs.stackone.com/guides/connector-engine/connector-yaml-reference.md)). This is a catalog-hygiene mechanism: internal plumbing doesn't pollute the agent-facing surface.

### 1.3 Naming: per-provider action IDs

Action IDs are `{connector_key}_{actionId}` — e.g. `airtable_list_bases`, `airtable_get_base_schema`, `bamboohr_list_employees` — as listed on each connector's page ([Airtable connector page](https://docs.stackone.com/connectors/airtable/index.md), [RPC/HTTP guide](https://docs.stackone.com/api/execute-actions.md)). There is **no cross-provider shared action ID** in the current catalog: "unified" is a property of the response envelope (`actionType`), not of the action's identity. Cross-provider uniformity at the action-ID level was the legacy unified-REST-API approach (`/unified/ats/candidates`), which StackOne is moving away from (§1.4).

### 1.4 The strategic pivot away from canonical-model REST APIs

- The HRIS unified API intro carries a tip: "**Building AI agents?** Use the [MCP Server], an [AI Toolset SDK], or the [Actions API (RPC)] instead. Same data, optimized for LLM tool calling." ([hris/introduction](https://docs.stackone.com/hris/introduction.md))
- The custom-field mapping guides are now served from `/legacy-unified-apis/common-guide/...` paths even when reached via current `/documents/common-guide/` URLs ([Field Mapping](https://docs.stackone.com/documents/common-guide/field-mapping.md), [Integration Field Mapping](https://docs.stackone.com/documents/common-guide/integration-field-mapping.md) — note the `/legacy-unified-apis/` hrefs inside).
- StackOne's blog states the positioning outright: "A unified API flattens every app's API into one shared schema. A StackOne connector does the opposite: it exposes each application's own capabilities as actions." ([Why unified APIs break for agents](https://www.stackone.com/blog/why-unified-apis-break-for-agents/) — **vendor marketing; promotional bias**.)
- The Documents and IAM unified APIs remain first-class sections in the docs index ([llms.txt](https://docs.stackone.com/llms.txt)), so the pivot is not absolute — canonical REST survives where the entity model is genuinely stable (drives/folders/files, users/groups).

## 2. Coverage gaps — how unsupported fields/actions are signaled, and the escape hatches

### 2.1 Static signaling: the Field Coverage dashboard

[Field Coverage](https://docs.stackone.com/documents/common-guide/field-coverage.md) is a **dashboard tool** (app.stackone.com/field_coverage), not a runtime API: a searchable matrix of which fields each connector supports per operation (GET/LIST/CREATE/UPDATE/UPSERT), with indicators for custom-field support, enums, required/conditionally-required, filtering, batch, and "**Unsupported by Provider**" (grey strikethrough). CSV export supported. Caveats are StackOne's own: coverage data "may not always reflect the complete picture" (dynamic fields, provider drift, conditional support) and users should "verify critical fields with actual API calls."

The `/actions` metadata endpoint does **not** carry per-field coverage. Its provider-level fields are `release_stage`, `categories`, `authentication`, `actions[]` (id/label/description/tags/`action_details` via `include=action_details`), and `event_actions[]` ([List all actions metadata API reference](https://docs.stackone.com/platform/api-reference/actions/list-all-actions-metadata.md)). Capability discovery at runtime is therefore at **action granularity** (is the action in the list?), not field granularity.

### 2.2 Runtime signaling: null-for-unsupported

The Documents API states the convention: "Field availability varies by integration provider. Optional fields may be `null` if the provider's API does not expose them." ([Unified Documents Actions](https://docs.stackone.com/documents/introduction.md)). No error is raised for an unsupported optional field — absence is signaled as `null`. The platform error vocabulary also reserves `501 Not Implemented` ("This functionality is not implemented") in the platform OpenAPI ([Proxy Request spec](https://docs.stackone.com/platform/api-reference/proxy/proxy-request.md)), though no docs page ties it specifically to unsupported unified operations.

### 2.3 Escape hatches

1. **`proxy[...]` passthrough query parameters** on unified REST APIs: any `proxy[custom-name]=value` query param is extracted and forwarded to the provider API ([Using the Passthrough Query Parameters](https://docs.stackone.com/documents/common-guide/using-the-passthrough-query-parameters.md)). StackOne's own caveats: not portable across providers; provider params StackOne uses internally take precedence over yours; provider may remove the filter without notice; overriding pagination params "may result in unexpected behaviour."
2. **`POST /unified/proxy`** — a full raw-request proxy (body: `url`, `method`, `path`, `headers`, `body`; returns provider status/headers/data verbatim): **deprecated** (`deprecated: true` in the OpenAPI; page titled "Proxy Request (Legacy)") ([Proxy Request spec](https://docs.stackone.com/platform/api-reference/proxy/proxy-request.md)). StackOne is retiring the raw-passthrough escape hatch, not investing in it.
3. **`custom` actionType actions** (§1.1) — the non-deprecated answer: provider-specific endpoints become declared actions with raw responses, inside the governed catalog (audit, scopes, MCP visibility) rather than outside it.
4. **Custom connectors** — for a wholly unsupported provider, customers build their own connector (Enterprise-gated: "Custom connectors require Enterprise access") ([Build Your First Connector](https://docs.stackone.com/guides/connector-engine/building-first-connector.md)).

## 3. Custom fields — consumer-defined extensions to canonical models

[Field Mapping](https://docs.stackone.com/documents/common-guide/field-mapping.md) + [Integration Field Mapping](https://docs.stackone.com/documents/common-guide/integration-field-mapping.md) document the **Custom Unified Fields** mechanism:

- A **Project Admin** defines a custom unified field: `Variable Key` (the JSON property), primitive `Variable Type` (string/number/boolean only — values typecast when possible), display name, description.
- Per integration, the admin maps the field to provider data using the **expression language** (JSONPath / JEXL / string interpolation), e.g. `$.employees.output.data.terminationDate`, ideally against a sandbox linked account with a preview/test loop.
- **Hard constraint**: custom fields can only reshape "data that is already returned by underlying connectors" — no extra provider requests.
- Read-only: List/Get operations only; writes "introduced in future updates."
- Values are **real-time** (computed from live provider responses) and returned embedded in a `unified_custom_fields` object on the unified model (camelCased `unifiedCustomFields` in SDKs, untyped).
- Gating: the feature must be enabled by StackOne support per organization; only pre-selected unified models are eligible.

Stated future direction: custom/derived fields with formulas, write support, and **account-specific overrides** ("different mapping per account... tenant-based custom fields"). Note (§1.4): this mechanism belongs to the legacy unified REST APIs, not the action catalog — there is no documented equivalent for actions.

## 4. Evolution — versioning, release stages, deprecation

### 4.1 Connector semver + profile pins

[Connector Versioning](https://docs.stackone.com/guides/connector-versioning.md): connectors are versioned `major.minor.patch`; each **connector profile** (the project's configured instance of a connector) resolves to one version, pinned independently per profile so staging/prod and different customer groups migrate at their own pace. Pin formats: `latest`, `1.x.x`, `1.2.x`, exact `1.2.0` (npm `^`/`~` rejected). Default resolution: latest **custom** version if one exists in the project, else latest StackOne version — custom connectors shadow built-ins at the same key even at equal versions. Pin API: `PUT/DELETE /connector_profiles/{id}/pinned_version`; versions listed via `GET /connector_profiles/{id}/versions` (returns resolved exact version + `pinned`/`builtin`/`owner`).

### 4.2 Breaking-change classification

StackOne's published table ([Connector Versioning](https://docs.stackone.com/guides/connector-versioning.md)):

| Bump | Example change | Breaking |
| --- | --- | --- |
| Patch | Bug fix, description update, internal refactor | No |
| Minor | New action, new optional parameter, new optional response field | No |
| Major | New auth type or required scope; removed/renamed field; changed response shape; removed action | Yes |

Major also covers **behavioral** changes: pagination, filtering, error semantics, default values. Auth-breaking majors follow a coordinated migration: new connector profile pinned to the new major → connect sessions targeting it → end users reauthenticate → accounts move to the new profile on successful auth. **Immutable versioning** (a published version number can't be overwritten) is enabled by default per project; disabling allows `stackone push --force` overwrites.

### 4.3 Release stages

`release_stage` exists at **connector level** (`ga` / `beta` / `preview`; "By default, StackOne organizations only have access to connectors in the 'ga' stage. To get access to 'beta' or 'preview' stage connectors, please contact support") and at **event level** — but **not** at action level: the `ActionMetaItem` schema has no `release_stage` field ([List all actions metadata](https://docs.stackone.com/platform/api-reference/actions/list-all-actions-metadata.md)). The connector catalog page data shows the same distribution: most connectors carry `preview`/`beta`, GA implied by absence ([Connectors](https://docs.stackone.com/connectors/introduction.md)).

### 4.4 Deprecation

No action- or model-level deprecation policy is documented. Observed practice: OpenAPI field-level deprecation (`integration_id` marked `deprecated: true` with "use `connector_profile_id` instead" in the actions metadata schema) and whole-endpoint deprecation (`/unified/proxy`, §2.3). Removed/renamed actions are simply classified as breaking changes requiring a major bump — the pin system *is* the deprecation safety net: consumers on a pinned version are unaffected until they move.

## 5. Mapping to totem — adopt now vs defer

Context: totem's registry is platform-owned (ADR-0001), connectors are pure translators (ADR-0003), both feishu and dingtalk implement one canonical set in `src/actions.ts` (doc actions + `read_sheet_cells`/`write_sheet_cells`), and list actions already use the `{data, next}` envelope (ADR-0012) — the same envelope StackOne's unified `list` type converged on.

### 5.1 What this research confirms (no change)

- **The `{data, next}` list envelope** (ADR-0012) matches StackOne's unified `list` response schema exactly.
- **No raw passthrough**: StackOne deprecated `/unified/proxy` and warns against `proxy[...]` params (non-portable, silent breakage). Totem has no passthrough surface; this validates not adding one.
- **Action-granularity capability discovery** via a metadata endpoint: totem's consumption standard + `/openapi.json` already play this role.

### 5.2 Feeds the live design decision (provider-specific capabilities)

StackOne's pattern for bitable-class capabilities: keep them in the governed catalog as **provider-scoped actions with provider-shaped output** (`actionType: custom`), named `{provider}_{action}` — don't stretch the canonical model, don't hide them, don't proxy them. Translated to totem options, this favors a **provider-native action** shape (e.g. `feishu_bitable_search_records`, feishu-connector-only, provider-typed output schema) over (a) forcing bitable into the canonical set or (b) an un governed passthrough. The exact shape (naming prefix, how the registry declares "connector X only", MCP advertisement per connection) is the design decision the map's fog anticipated — now specifiable as a ticket, likely an ADR.

### 5.3 Adopt NOW (cheap, v1-consistent)

1. **The breaking-change classification table** (§4.2) as the registry's change policy: additive (new action, optional field) = safe; removal/rename/behavioral = breaking. Round 1 already adopted connector semver as a convention; this extends it to a published rule for evolving `src/actions.ts`. Costs nothing; prevents ad-hoc breakage of the two consumers.
2. **Null-for-unsupported optional fields** (§2.2) as an explicit convention in the consumption standard, if not already written down — avoids inventing an error for "this provider doesn't have this field."
3. **Internal-category hygiene idea** (§1.2): if totem ever grows platform-internal actions (refresh, probes), they should be excludable from MCP advertisement the way allowlists already filter tools — the mechanism exists (hide, don't reject); no build needed now.

### 5.4 Defer to v2 (contract pre-recorded)

1. **Per-connector/per-action support matrix in metadata** (Field Coverage, §2.1): valuable once the canonical set has provider-optional actions; at two connectors the registry's `implements` list suffices. Contract: expose support per (connector, action) in the registry metadata endpoint.
2. **Version pinning infrastructure** (§4.1): connector-profile pins, wildcards, immutable publishing — already deferred in round 1; this research adds the pin-format vocabulary (`latest` / `1.x.x` / exact; reject `^`/`~`).
3. **Tenant-defined custom fields** (§3): StackOne gates it to admins, read-only, primitives only, and it's tied to the legacy surface — no totem equivalent is justified while tenants are mutually trusted internal projects (ADR-0010).
4. **Action-level release stages**: StackOne only stages connectors, not actions; if totem wants experimental actions (bitable could be one), an action-level `release_stage` in registry metadata would *exceed* StackOne — decide in the provider-native-actions ticket.

### 5.5 What StackOne lacks (totem should define for itself)

A **deprecation policy for actions** (§4.4): StackOne leans on pins and major bumps. Totem's registry has no pinning yet, so a removal today breaks consumers immediately. The provider-native-actions/catalog-conventions ticket should define deprecation semantics (e.g. `deprecated` flag in action metadata + removal rules) before the canonical set grows.

## Sources

### Kept

- [Connector YAML Reference](https://docs.stackone.com/guides/connector-engine/connector-yaml-reference.md) — `actionType` table, unified vs custom semantics, categories/internal, effects.
- [Connector Versioning](https://docs.stackone.com/guides/connector-versioning.md) — semver pins, breaking-change classification, migration pattern, immutable versioning.
- [List all actions metadata (API reference)](https://docs.stackone.com/platform/api-reference/actions/list-all-actions-metadata.md) — provider/action/event metadata schemas, `release_stage` levels, `include=action_details`, deprecated `integration_id`.
- [Actions Metadata for Custom UIs](https://docs.stackone.com/api/actions-metadata.md) — runtime action-granularity capability discovery.
- [RPC/HTTP](https://docs.stackone.com/api/execute-actions.md) — action naming, RPC call shape.
- [Field Coverage](https://docs.stackone.com/documents/common-guide/field-coverage.md) — per-field support matrix dashboard, indicators, caveats.
- [Field Mapping](https://docs.stackone.com/documents/common-guide/field-mapping.md) — Custom Unified Fields: definition, constraints, `unified_custom_fields`.
- [Integration Field Mapping](https://docs.stackone.com/documents/common-guide/integration-field-mapping.md) — per-integration mapping, expression language, preview/test.
- [Using the Passthrough Query Parameters](https://docs.stackone.com/documents/common-guide/using-the-passthrough-query-parameters.md) — `proxy[...]` mechanism + caveats.
- [Proxy Request (API reference)](https://docs.stackone.com/platform/api-reference/proxy/proxy-request.md) — `/unified/proxy` deprecated; error vocabulary incl. 501.
- [Unified Documents Actions](https://docs.stackone.com/documents/introduction.md) — entity model, null-for-unsupported note.
- [Connectors catalog](https://docs.stackone.com/connectors/introduction.md) — release stages, categories, action counts (JS data).
- [Airtable connector page](https://docs.stackone.com/connectors/airtable/index.md) — per-provider action listing with required scopes.
- [Build Your First Connector](https://docs.stackone.com/guides/connector-engine/building-first-connector.md) — custom connectors Enterprise-gated; CLI validate/run/push loop.
- [Connector File Structure](https://docs.stackone.com/guides/connector-engine/connector-structure.md) — main + partial YAML layout, `actionType: custom` example.
- [hris/introduction](https://docs.stackone.com/hris/introduction.md) — tip redirecting agent builders to the action surface.
- [Why unified APIs break for agents](https://www.stackone.com/blog/why-unified-apis-break-for-agents/) — strategic positioning (vendor marketing; bias flagged).

### Dropped

- SDK proxy READMEs (github.com/StackOneHQ SDK repos) — third-party-generated client docs; the canonical spec is the docs OpenAPI, which was fetched directly.
- Search-engine snippets quoting "Unified Actions / Direct access" prose on `guides/explore-connectors` and a `schema` property table on `connector-structure` — **not present in the current live pages** (verified by direct fetch); treated as stale index, not cited as fact.

## Gaps

- **The `schema` property for unified actions** ("Specifies which StackOne schema to map to") appears only in a stale search snippet of `connector-structure.md`; the live page no longer contains it, and the YAML reference's action schema section doesn't document how a `list`/`get` action declares which canonical model it conforms to. The unified-type envelope is documented; the model-mapping mechanism is not.
- **Whether unified-typed actions are actually cross-provider** at the schema level beyond the envelope (e.g. do `bamboohr_list_employees` and `workday_list_employees` return the same employee fields?) could not be verified from docs — needs API access or the connectors-template repo.
- **501 Not Implemented** exists in the platform error vocabulary but no page ties it to unsupported unified operations; runtime signaling for unsupported *actions* (vs fields) is undocumented.
- **Connector/action counts still drift**: llms.txt header says "10,000+ actions" / "400 connectors / 22,000 actions" in places, catalog page says "470+ connectors and 29000+ actions" — same inconsistency class as round 1.
- **Deprecation timelines** (how long a deprecated endpoint/field lives) are undocumented anywhere.
