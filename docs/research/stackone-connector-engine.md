# Research: StackOne Falcon Connector Engine

**Date:** 2026-02 · **Repo:** 0xnicholas/totem · **Branch target:** `research/connector-engine`

**Question:** How does StackOne's Falcon connector engine work — connector structure (YAML), expression language (JSONPath/JEXL), step functions, defined output schemas, authentication models, StackOne Agent, CLI, CI/CD deployment, connector versioning — and how do connectors declare which actions they implement? What should totem (ADR-0003 code connectors) borrow?

## Summary

Falcon is StackOne's connector engine: connectors are **YAML files in Git** — one `{provider}.connector.s1.yaml` plus `{provider}.{resource}.s1.partial.yaml` action partials — that declaratively describe auth, HTTP requests, pagination, and field mapping via JSONPath/JEXL/`${...}` expressions and a fixed set of step functions ([introduction](https://docs.stackone.com/guides/connector-engine/introduction.md), [file structure](https://docs.stackone.com/connector-yaml-reference/file-structure)). Actions are **defined by the connector itself** in YAML (`actionId`, `actionType`, `inputs`, `steps`, `result`) and become MCP tools named `{provider_key}_{actionId}` ([YAML reference](https://docs.stackone.com/guides/connector-engine/connector-yaml-reference.md)) — the opposite of totem's platform-owned registry where connectors declare `implements` and never define actions. The engine is supported by an MCP-enabled AI build agent (`stackone agent setup`), a CLI (`validate`/`run`/`push`/`pull`), GitHub Actions CI/CD, and semver + per-profile pinning with immutable versions ([stackone agent](https://docs.stackone.com/guides/connector-engine/stackone-agent.md), [CLI](https://docs.stackone.com/guides/connector-engine/cli-reference.md), [github-workflow](https://docs.stackone.com/guides/connector-engine/github-workflow.md), [connector-versioning](https://docs.stackone.com/connector-building/connector-versioning)).

Falcon does **not** invalidate totem's "pure translator" connector abstraction — `request`/`map_fields`/`result` is precisely that translator encoded declaratively — but it does challenge *where action definitions live* and scales via a YAML DSL + AI generation that totem does not need yet. Totem should borrow cheap, high-leverage ideas now (action `effects` → MCP annotations, unified `list → {data, next}` output shapes, hidden/`internal` actions, connection test actions) and defer the expensive ones (YAML DSL interpreter, registry-upload CI/CD, per-connection version pinning) until connector count and multi-provider unification demand them.

---

## 1. Falcon connector anatomy — file layout, YAML structure, auth models

### 1.1 File layout

A connector is a directory with a main file and optional per-resource partials ([file structure](https://docs.stackone.com/connector-yaml-reference/file-structure), [connector-structure](https://docs.stackone.com/guides/connector-engine/connector-structure.md)):

```
connectors/{provider}/
├── {provider}.connector.s1.yaml           # Main connector: metadata, auth, baseUrl, actions $refs
└── {provider}.{resource}.s1.partial.yaml  # Actions for one resource (array of action objects)
```

- The `.s1` suffix is the connector-file schema generation (`StackOne: 1.0.0` at the top of the main file is the only supported schema version; it selects the parser/validator) ([YAML reference](https://docs.stackone.com/guides/connector-engine/connector-yaml-reference.md)).
- The main file references partials with `$ref: {provider}.{resource}`; the CLI resolves `$ref` at build time (`stackone push`) by looking for `{provider}.{resource}.s1.partial.yaml` in the same directory, and merges all partial actions into one connector definition ([YAML reference](https://docs.stackone.com/guides/connector-engine/connector-yaml-reference.md)).
- Partials are YAML **arrays** — they start with `- actionId: ...`, not `actions:` — a common validation failure ([github-workflow](https://docs.stackone.com/guides/connector-engine/github-workflow.md)).
- StackOne publishes real connectors in [StackOneHQ/connectors-template](https://github.com/StackOneHQ/connectors-template) as working references ([YAML reference](https://docs.stackone.com/guides/connector-engine/connector-yaml-reference.md)).

### 1.2 Main connector file — root properties

| Property | Purpose | Source |
|---|---|---|
| `StackOne: 1.0.0` | Connector file schema version (only `1.0.0` supported) | [YAML reference](https://docs.stackone.com/guides/connector-engine/connector-yaml-reference.md) |
| `info.title` | Human-readable provider name (UI) | [YAML reference](https://docs.stackone.com/guides/connector-engine/connector-yaml-reference.md) |
| `info.key` | Unique, lowercase-alphanumeric-with-underscores identifier; **cannot change after deploy** (breaks linked accounts); prefixes MCP tool names → `bamboohr_list_employees` | [YAML reference](https://docs.stackone.com/guides/connector-engine/connector-yaml-reference.md) |
| `info.version` | Semver version of the connector (major = breaking) | [YAML reference](https://docs.stackone.com/guides/connector-engine/connector-yaml-reference.md) |
| `info.assets.icon` | Logo URL (UI) | [YAML reference](https://docs.stackone.com/guides/connector-engine/connector-yaml-reference.md) |
| `info.description` | Connector description (UI + MCP metadata) | [YAML reference](https://docs.stackone.com/guides/connector-engine/connector-yaml-reference.md) |
| `baseUrl` | Root URL for all requests; supports `${credentials.subdomain}` / `${config.region}` interpolation; per-action override allowed | [YAML reference](https://docs.stackone.com/guides/connector-engine/connector-yaml-reference.md) |
| `rateLimit.mainRatelimit` | Requests/sec per linked account; queued + exponential backoff | [YAML reference](https://docs.stackone.com/guides/connector-engine/connector-yaml-reference.md) |
| `context` | Provider API documentation URL for agent context | [file structure](https://docs.stackone.com/connector-yaml-reference/file-structure) |
| `scopeDefinitions` | Declares scopes an action can require (OAuth scopes, pricing tiers, feature flags), with `includes` hierarchy; referenced by `requiredScopes`/`applicableScopes`, validated at build | [YAML reference](https://docs.stackone.com/guides/connector-engine/connector-yaml-reference.md) |
| `documentation.references` | Structured external doc links surfaced in `/actions` API | [YAML reference](https://docs.stackone.com/guides/connector-engine/connector-yaml-reference.md) |
| `authentication` | Array of auth methods (see §1.3) | [YAML reference](https://docs.stackone.com/guides/connector-engine/connector-yaml-reference.md) |
| `actions` | List of `$ref:` partials to merge | [YAML reference](https://docs.stackone.com/guides/connector-engine/connector-yaml-reference.md) |

**Fork/inherit rule:** to keep inheriting StackOne's updates after forking, keep `info.key` identical to the upstream key — changing `info.title` is fine, changing `info.key` disables update inheritance ([YAML reference](https://docs.stackone.com/guides/connector-engine/connector-yaml-reference.md)).

### 1.3 Authentication models

`authentication` is an array so one connector can offer several methods (e.g. Slack OAuth **and** bot token), each with independent credential storage and its own runtime auth handler ([YAML reference](https://docs.stackone.com/guides/connector-engine/connector-yaml-reference.md)).

**OAuth 2.0 (`type: oauth2`)** ([YAML reference](https://docs.stackone.com/guides/connector-engine/connector-yaml-reference.md)):
- `authorization.authorizationUrl` + `authorizationParams` (values can be JSONPath/JEXL, e.g. `scope: '{{$.credentials.scopes ?? "employees:read"}}'`), `tokenUrl`, `token` (JSONPath to the token in credentials), `includeBearer`, `pkce: true`.
- `setupFields` — **per connector profile**: OAuth client ID/secret etc., entered once by the platform operator; `secret: true` fields are encrypted at rest and never returned by the API.
- `configFields` — **per linked account**: end-user credentials (their API key, subdomain, region).
- `refreshAuthentication` — an **embedded action** (declared inline, `actionType: refresh_token`, `categories: [internal]`) that runs when a request 401s: call the token endpoint, `map_fields` the response to `accessToken`/`refreshToken`, update stored credentials, retry the original action.
- `environments` — sandbox/production toggles (available to expressions as `$.environment.key`).
- `testActions` — actions executed after connect to validate the connection (`required: true` → connection marked failed if the action fails).

**Custom auth (`type: custom`)** — API key / basic / none ([YAML reference](https://docs.stackone.com/guides/connector-engine/connector-yaml-reference.md)):
- `authorization.type`: `bearer` (`Authorization: Bearer {token}`, or raw with `includeBearer: false`), `basic` (base64 `username:password`), `none`; plus `customHeaders` for non-standard schemes (`X-Api-Key: $.credentials.apiKey`).
- Same `configFields`/`setupFields`/`environments`/`testActions` machinery.

Auth is declared once at connector level and **inherited by every action**, which can override it per step ([platform page](https://www.stackone.com/platform/agent-execution-engine/), [step functions](https://docs.stackone.com/connector-yaml-reference/step-functions)). `support.guides.config/setup` carry structured setup instructions rendered into the Hub and docs ([YAML reference](https://docs.stackone.com/guides/connector-engine/connector-yaml-reference.md)).

---

## 2. Expression language + step functions — how actions are composed declaratively

### 2.1 Expression language (via `@stackone/expressions`)

Three formats, **never mixed in one value** ([expression-language](https://docs.stackone.com/guides/connector-engine/expression-language.md), [expression-syntax](https://docs.stackone.com/connector-yaml-reference/expression-syntax)):

1. **JSONPath** (`$.path`) — direct data access. Contexts: `$.credentials`, `$.inputs`, `$.config`, `$.steps.{stepId}.output` (previous step), `$.response` (response handling), `$.iterator` (foreach). Supports filters `$.users[?(@.age > 30)]`, slices, wildcards, recursive descent.
2. **String interpolation** (`${...}`) — value substitution inside strings/URLs: `url: /users/${inputs.id}`, `baseUrl: https://${credentials.subdomain}.api.provider.com`. No operators/conditionals.
3. **JEXL** (`'{{...}}'`, single-quoted in YAML) — logic: arithmetic, comparison, logical, ternary `? :`, nullish coalescing `??`, collection filters `users[.age > 25].name`, plus **built-in functions**: `present`/`missing`, `capitalize`, `truncate`, `padStart`, `encodeBase64`/`decodeBase64`, `regexMatch`/`extractMatch`, `sha256`/`hmacSha256`/`md5`, `includes`/`includesSome`, `dedupe`/`join`/`reduce`, `keys`/`values`/`zipObject`/`groupBy`, `now`/`yearsElapsed`/`hasPassed`/`deltaFromNowMs`.

The dominant JEXL pattern is **conditional argument inclusion**: an `args` entry carries `condition: '{{present(inputs.filter)}}'` so optional query params/body fields are omitted when the input is absent ([expression-language](https://docs.stackone.com/guides/connector-engine/expression-language.md)). `isValidExpression` gives syntax validation with incremental JSONPath errors that the StackOne Agent uses for self-repair; `safeEvaluate` returns `null` instead of throwing ([expression-syntax](https://docs.stackone.com/connector-yaml-reference/expression-syntax)).

### 2.2 Step functions

An action is a `steps:` array executed sequentially; each step is a `stepFunction` with a `functionName` and `parameters`, optionally gated by `condition` (JEXL), marked `ignoreError`, or wrapped in an `iterator` (foreach) ([step-functions](https://docs.stackone.com/connector-yaml-reference/step-functions)):

| Function | Role |
|---|---|
| `request` | HTTP call: `baseUrl`/`url`, `method`, `authorization` override, `args` with `in: path/query/body/headers`, `response.dataKey`/`indexField`, `customErrors` (remap provider error statuses, e.g. GraphQL 200-with-errors) |
| `paginated_request` | Auto-pagination: `pagination.type: cursor`, `request.cursor_field/cursor_position`, `response.cursor_path/data_path`; loops until no cursor; MCP clients get first page + `next` cursor to pass back |
| `map_fields` | Field mapping: `fields[].targetFieldKey` + `expression` (JEXL, source object as context) + `type` (string/number/boolean/datetime_string); `dataSource` JSONPath; **`enumMapper`** for enum translation ("Active" → `active`) |
| `group_data` | Group a flat array by a field |
| `typecast` | Coerce types, incl. `json` (parse JSON string → object) |
| `soap_request` | SOAP (Workday-class providers): `soapOperation`, `namespaces`, XML attribute `@_`/`#text` syntax |
| `static_values` | Return constant data without an API call (enum lookups) |
| `merge_collections` | Merge arrays (static defaults + fetched data) |
| `code_execution_lambda` | **Escape hatch**: invoke an AWS Lambda (RequestResponse/Event/DryRun) for transformations that don't fit the DSL |
| iterator steps | `iterator:` JSONPath over an array + `stepFunction(s)` per item; context `$.iterator.item/index/current`; results collected into `$.steps.{id}.output.data` |

**`result`** closes the action: `data` (returned to caller), plus optional `rawRequest`/`rawResponse` for debugging ([YAML reference](https://docs.stackone.com/guides/connector-engine/connector-yaml-reference.md)).

### 2.3 How actions are declared (the "which actions do connectors implement" question)

Falcon flips totem's model: **the connector's YAML is the action catalog**. Each partial entry defines one action ([YAML reference](https://docs.stackone.com/guides/connector-engine/connector-yaml-reference.md)):

- `actionId` — snake_case, unique within connector; the **MCP tool name is derived** as `{info.key}_{actionId}` (e.g. `bamboohr_list_employees`). Conventions: `list_*`, `get_*`, `create_*`, `update_*`, `delete_*`, `search_*`.
- `categories` — UI taxonomy (`hris`, `ats`, `crm`, `lms`, `ticketing`, `messaging`, `filestorage`, `marketing`, `internal`…). **`internal` actions are hidden from MCP `list tools` and UI but still callable via direct API** (used for token refresh).
- `actionType` — **the unified-output contract**: `custom` (raw provider response), `list` (`{data: [], next: string}`), `get`/`create`/`update` (`{data: object}`), `delete` (`{success: boolean}`), `refresh_token`. Unified types enforce consistent response schemas across providers and normalize errors; `custom` passes through raw.
- `effects` — `read`/`search`/`write`/`delete`/`execute`, **derived into MCP tool annotations**: `readOnlyHint` (true iff all effects read/search), `destructiveHint` (true if delete), `openWorldHint` (always true); `idempotentHint` is never inferred and can be set via an `annotations` override. With no effects, no annotations are emitted.
- `label`, `description` (short, ~100 chars), `details` (full MCP tool description), `resources` (action docs link).
- `inputs` — typed parameters with `in: path/query/body/header`, `required`, `default`, `array`, nested `properties` for `type: object`, `variants` for multi-shape fields, `values` for enums; **converted to JSON Schema for MCP tool input schemas**.
- `steps`, `result` (§2.2).

After publishing, the connector profile page in the project UI lets the operator **enable/disable which actions are exposed** ([github-workflow](https://docs.stackone.com/guides/connector-engine/github-workflow.md)) — a runtime-level "which actions does this deployment expose" knob on top of the YAML-declared set.

---

## 3. Defined output schemas — how outputs are normalized

The docs frame it explicitly ([defined-output-schemas](https://docs.stackone.com/connector-building/defined-output-schemas)):

> A connector can pass the provider's response through as-is, or map it onto an output schema you define so every provider in a category returns the same shape.

Mechanism:
- `map_fields` maps provider fields onto your `targetFieldKey` names (with enum translation via `enumMapper`); `typecast` runs after to coerce mapped values to declared types ([defined-output-schemas](https://docs.stackone.com/connector-building/defined-output-schemas), [step-functions](https://docs.stackone.com/connector-yaml-reference/step-functions)).
- The **target schema is written down as a reference** (in the connector repo / agent context) so the AI agent maps a new provider's response to it "without being asked, including the enum normalization that is easy to get subtly wrong by hand" ([defined-output-schemas](https://docs.stackone.com/connector-building/defined-output-schemas)).
- `actionType` provides a second, coarser normalization: `list`/`get`/`create`/`update`/`delete` enforce the unified response envelopes above, and `result.data` defines exactly what the caller receives ([YAML reference](https://docs.stackone.com/guides/connector-engine/connector-yaml-reference.md)).
- There is **no platform-owned JSON Schema registry like totem's**: the "defined output schema" is the connector author's YAML (`targetFieldKey`s + `result.data` + `actionType`), and cross-provider consistency is a *convention* (same target schema for every provider in a category), not a compiled platform schema. Validation is `stackone validate` (syntax/structure) rather than Ajv-compiled output-schema checks ([CLI](https://docs.stackone.com/guides/connector-engine/cli-reference.md)).

---

## 4. Tooling — StackOne Agent, CLI, CI/CD, versioning

### 4.1 StackOne Agent (AI-assisted connector building)

- `stackone agent setup --local` authenticates, writes a project `.mcp.json` (MCP server giving the coding assistant StackOne's tools), installs **connector-building skills into `.claude/skills/`**, and adds a guide block to `CLAUDE.md`; `--global` registers only the MCP server in `~/.claude.json` ([CLI](https://docs.stackone.com/guides/connector-engine/cli-reference.md)).
- Workflow is optimized for Claude Code but works with Cursor, VS Code + Claude, and opencode; the `/connector-onboarding` skill walks through provider, auth, endpoints, and actions, confirming each part ([first-connector](https://docs.stackone.com/guides/connector-engine/building-first-connector.md), [introduction](https://docs.stackone.com/guides/connector-engine/introduction.md)).
- Non-interactive/terminal use: `stackone agent chat` (modes: `build`/`test`/`research`), `stackone agent run "<prompt>" --max-turns N`, `stackone agent skills`, `stackone agent sync` (refresh skills; `--check` reports drift and exits non-zero — used in CI), `stackone agent cleanup` ([CLI](https://docs.stackone.com/guides/connector-engine/cli-reference.md)).
- Note: `docs.stackone.com/guides/connector-engine/stackone-agent.md` currently resolves to the CLI reference's agent section — the agent is documented through the CLI + first-connector guide rather than a standalone page.

### 4.2 CLI (`@stackone/cli`, Node.js 18+)

- **Develop:** `stackone validate <path> [--watch]` (YAML syntax/structure), `stackone run --connector … --account-id … --action-id … [--debug] [--params …] [--output-file …]` (executes an action against a real linked account; `--debug` shows raw request/response and each step's I/O) ([CLI](https://docs.stackone.com/guides/connector-engine/cli-reference.md)).
- **Deploy:** `stackone push <path>` (`connectors:write`), `stackone pull [--connector provider@version]` (`connectors:read`), `stackone drop <provider@version>`, `stackone get` (retrieve config as YAML/JSON) ([CLI](https://docs.stackone.com/guides/connector-engine/cli-reference.md)).
- **Config:** `stackone init` creates named profiles (staging/prod), `--profile` selects one; `stackone version` / `stackone update`.
- "Connectors are code, so keeping them in version control gives you history and review… and is what publishing through GitHub CI/CD builds on" ([first-connector](https://docs.stackone.com/guides/connector-engine/building-first-connector.md)).

### 4.3 CI/CD & deployment

The recommended GitHub Actions pipeline ([github-workflow](https://docs.stackone.com/guides/connector-engine/github-workflow.md)):
- Validate on every PR (`stackone validate connectors/`) and check agent skill drift (`stackone agent sync --check`, needs no credentials); publish on merge (`stackone push connectors/` with `STACKONE_API_KEY` secret, `connectors:write` scope).
- Multi-environment: one secret per project (`STACKONE_API_KEY_DEV/STAGING/PROD`) and branch routing (`develop → dev`, `staging → staging`, `main → prod`, optionally `environment: production` for manual approval).
- Push merges partials via `$ref` resolution; linked accounts are unaffected by new pushes until moved (versioning below).

### 4.4 Connector versioning

- Semver `major.minor.patch`; breaking changes are **major**: auth changes (new auth type, required scopes, changed credential fields — these force re-authentication), response/request shape changes, removed/renamed actions, behavioral changes (pagination, error semantics, defaults) ([connector-versioning](https://docs.stackone.com/connector-building/connector-versioning)).
- **Each connector profile pins independently** — test a new version on a staging profile, roll out to production later; migrate customer groups at their own pace.
- Pin formats: `latest` (newest custom else StackOne), `1.x.x` (auto-update within major), `1.2.x` (patch only), `1.2.0` (exact, never changes). npm `^`/`~` not accepted. Custom connectors **always take precedence** over StackOne's same-key connector.
- **Immutable versioning is enabled by default**: published versions can't be overwritten; `stackone push --force` only works after disabling it in Project Settings → Danger Zone.
- Practical migration flow: for auth-breaking changes, create a new connector profile and route users through a fresh connect flow; non-breaking releases roll out automatically to profiles on auto-updating pins.

---

## 5. EXPLICIT COMPARISON: Falcon declarative YAML connectors vs totem ADR-0003 code connectors

**Totem's model (ground truth from the repo):** actions are platform-owned (ADR-0001): `Action { name, description, inputSchema, outputSchema }` live in `src/actions.ts`; the registry compiles schemas with Ajv; a connector is a thin `IConnector { manifest: { id, implements: string[] }, execute(action, args, ctx) }` — a pure translator that never defines actions, never touches governance ([src/connector.ts](/Users/nicholasl/Documents/build-whatever/totem/src/connector.ts), [src/action.ts](/Users/nicholasl/Documents/build-whatever/totem/src/action.ts), [src/registry.ts](/Users/nicholasl/Documents/build-whatever/totem/src/registry.ts)). `executeAction` (Seam A) validates input, dispatches through the connection's connector, validates output against the platform schema, maps errors to the unified vocabulary ([src/executor.ts](/Users/nicholasl/Documents/build-whatever/totem/src/executor.ts)). v1: 3 Docs actions (`create_doc`, `read_doc`, `list_docs`) with opaque IDs ([src/actions.ts](/Users/nicholasl/Documents/build-whatever/totem/src/actions.ts)).

**Falcon's model:** the connector YAML *is* the action catalog (actionId/categories/actionType/inputs/steps/result); MCP tool names derive from `{key}_{actionId}`; output normalization is `actionType` envelopes + `map_fields`/`typecast` conventions; "defined output schemas" are per-category author conventions, not a compiled registry ([YAML reference](https://docs.stackone.com/guides/connector-engine/connector-yaml-reference.md), [defined-output-schemas](https://docs.stackone.com/connector-building/defined-output-schemas)).

### What Falcon gets right that totem should borrow

**Borrow now (cheap, high leverage):**

1. **`effects` → MCP annotations.** Falcon derives `readOnlyHint`/`destructiveHint`/`openWorldHint` from `effects: [read|search|write|delete|execute]`, letting MCP clients auto-approve reads and prompt before writes ([YAML reference](https://docs.stackone.com/guides/connector-engine/connector-yaml-reference.md)). Totem already maps actions → MCP tools and owns the `Action` shape; adding an `effects` field and emitting standard MCP tool annotations is a small change to `src/actions.ts` + the MCP adapter, with direct agent-UX value. This also reinforces totem's allowlist philosophy ("hide, don't reject").
2. **Unified list envelope convention.** Falcon's `list` actions always return `{data: [], next}` so agents paginate uniformly and MCP gets first page + cursor ([YAML reference](https://docs.stackone.com/guides/connector-engine/connector-yaml-reference.md)). Totem's `list_docs` output is already normalized (`{docs: [...]}`); adopting an explicit `{data, next}`-style convention (or documenting the current one as the standard) across future connectors prevents per-connector drift — a documentation/ADR-level change, not an engine change.
3. **Hidden/`internal` actions.** Falcon's `categories: [internal]` hides actions from MCP `list tools` but keeps them callable via direct API (token refresh) ([YAML reference](https://docs.stackone.com/guides/connector-engine/connector-yaml-reference.md)). Totem's allowlist already hides tools; adding an `internal`/`hidden` flag to `Action` (excluded from MCP advertisement, still executable) would cover system-internal actions cleanly.
4. **Connection test actions.** Falcon's `testActions` validate a connection on creation (`required: true` → connect fails if the probe action fails) ([YAML reference](https://docs.stackone.com/guides/connector-engine/connector-yaml-reference.md)). Totem connections are data rows; a per-connector `probe(connection)`-style capability would give real "did the Feishu token work?" validation at connect time — a small interface addition (e.g. optional method on `IConnector`).
5. **Rate limiting declared per connector.** Falcon's `rateLimit.mainRatelimit` (per account, queued with backoff) ([YAML reference](https://docs.stackone.com/guides/connector-engine/connector-yaml-reference.md)) maps onto totem's `rate_limited` retryable error — declaring per-provider limits in the manifest (`manifest.rateLimit`) would let `executeAction` throttle uniformly instead of each connector re-implementing it.

**Borrow later (needs a trigger — connector count / multi-provider domains):**

6. **Per-connection/per-profile connector version pinning.** Falcon's semver + independent pinning (`latest`, `1.x.x`, `1.2.x`, exact) with immutable versions and custom-over-StackOne precedence is a first-class rollout mechanism ([connector-versioning](https://docs.stackone.com/connector-building/connector-versioning)). Totem's `ConnectionRecord.connectorId` is a bare string; version pinning per connection is a real governance feature but premature at v1 scale. Revisit when the first breaking provider API change ships to real tenants.
7. **AI-assisted connector generation.** The StackOne Agent pattern (MCP server + `.claude/skills/` + an onboarding skill; agent drafts YAML from provider docs, human validates) ([first-connector](https://docs.stackone.com/guides/connector-engine/building-first-connector.md), [CLI](https://docs.stackone.com/guides/connector-engine/cli-reference.md)) is replicable for totem's code connectors (a skill that scaffolds an `IConnector` + test suite). Cheap to defer until the second or third real connector.
8. **Connector-version CI/CD with environment routing** — Falcon's validate-on-PR/push-on-merge per environment ([github-workflow](https://docs.stackone.com/guides/connector-engine/github-workflow.md)) is just totem's existing lint/typecheck/test CI plus a release gate. The *concept* is borrowed; the *mechanism* stays normal TypeScript CI.

**Deliberately not borrowed:**

9. **The YAML DSL itself (YAML interpreter runtime, JEXL engine, step-function VM, `$ref` partial merge).** Falcon's declarative surface is only viable because it powers 200+ pre-built connectors ([introduction](https://docs.stackone.com/guides/connector-engine/introduction.md), now 470+ / 28,000+ actions in the catalog ([connectors intro](https://docs.stackone.com/connectors/introduction.md))) and because the DSL is backed by an AI build agent. Totem has 1 connector and 3 curated actions ([src/actions.ts](/Users/nicholasl/Documents/build-whatever/totem/src/actions.ts)); a YAML interpreter would add a runtime dependency, a validation pipeline, and a debugging surface for zero current benefit. The escape hatches Falcon itself needs (`code_execution_lambda` for anything the DSL can't express, [step-functions](https://docs.stackone.com/connector-yaml-reference/step-functions)) are evidence that the DSL is a distribution vehicle, not a capability edge — totem's TypeScript connector *is* the escape hatch, so it doesn't need the DSL.

### Does Falcon challenge totem's connector abstraction itself?

**No — it validates it.** Falcon's `request` + `map_fields` + `result` is exactly totem's ADR-0003 pure translator ("unified args → system request, system response → unified output") written declaratively: `inputs` → `args` (path/query/body/header) is args→request; `map_fields`/`typecast`/`result.data` is response→unified output; `customErrors` is error normalization ([step-functions](https://docs.stackone.com/connector-yaml-reference/step-functions), [YAML reference](https://docs.stackone.com/guides/connector-engine/connector-yaml-reference.md)). Falcon's runtime layer (token refresh, rate limiting, test actions) matches totem's execution-boundary responsibilities (token acquisition, allowlist, audit in `executeAction`, [src/executor.ts](/Users/nicholasl/Documents/build-whatever/totem/src/executor.ts)). The abstraction survives.

**What it *does* challenge is who owns action definitions.** Falcon lets each connector define its own actions with provider-prefixed MCP names (`bamboohr_list_employees` vs `workday_list_employees`) — cross-provider uniformity is a convention (defined output schemas + `actionType` envelopes), enforced by author discipline and AI-assisted generation, not by a registry. Totem's registry-first model (platform owns `name`/`description`/schemas; connectors declare `implements`) is stronger for totem's actual goal — a *curated, cross-provider-stable* action set where `create_doc` means the same thing for any connected system — and it's the reason totem should *not* adopt Falcon's "connector defines actions" direction. The one place totem's model is weaker today: **action metadata that feeds agent tooling**. Falcon surfaces `effects`, `details`, `categories`, and scope info to the agent ([YAML reference](https://docs.stackone.com/guides/connector-engine/connector-yaml-reference.md)); totem's `Action` carries only name/description/schemas. Enriching the platform `Action` type with that metadata (borrow-now items 1–4) gives totem Falcon-grade agent ergonomics while keeping its superior action-governance model.

---

## Sources

### Kept
- [Connector Engine Introduction](https://docs.stackone.com/guides/connector-engine/introduction.md) — Falcon naming; powers 200+ pre-built connectors; agent-centric workflow.
- [Build Your First Connector](https://docs.stackone.com/guides/connector-engine/building-first-connector.md) — full build/test/push loop; agent onboarding skill; Node 18+; CLI usage.
- [Connector Structure](https://docs.stackone.com/guides/connector-engine/connector-structure.md) — file organization, auth, actions, steps, expressions overview.
- [Expression Language](https://docs.stackone.com/guides/connector-engine/expression-language.md) — JSONPath/JEXL/interpolation reference + built-in functions.
- [Connector YAML Reference](https://docs.stackone.com/guides/connector-engine/connector-yaml-reference.md) — every YAML property, auth models, actions, `effects`→MCP annotations, result.
- [StackOne Agent](https://docs.stackone.com/guides/connector-engine/stackone-agent.md) — agent commands (setup/chat/run/skills/sync); currently resolves to the CLI agent section.
- [CLI Reference](https://docs.stackone.com/guides/connector-engine/cli-reference.md) — validate/run/push/pull/drop/get/init + scopes.
- [GitHub Workflow (CI/CD)](https://docs.stackone.com/guides/connector-engine/github-workflow.md) — GitHub Actions validation + deploy, multi-environment routing, common errors.
- [Defined Output Schemas](https://docs.stackone.com/connector-building/defined-output-schemas) — map_fields + typecast + target schema for cross-provider consistency.
- [Connector Versioning](https://docs.stackone.com/connector-building/connector-versioning) — semver policy, profile pinning formats, custom precedence, immutable versions.
- [Customizing Connectors](https://docs.stackone.com/connector-building/customizing-connectors) — pull → edit → validate → run → push fork loop.
- [Connector Building Overview](https://docs.stackone.com/connector-building/overview) — two paths (StackOne-built vs self-built, YAML-in-Git).
- [Step Functions](https://docs.stackone.com/connector-yaml-reference/step-functions) — request/paginated_request/map_fields/group_data/typecast/soap/static/merge/lambda/iterator.
- [File Structure](https://docs.stackone.com/connector-yaml-reference/file-structure) — main file + partial naming, `$ref` merge, complete example.
- [Connectors Introduction](https://docs.stackone.com/connectors/introduction.md) — catalog scale (470+ connectors, 28,000+ actions).
- [StackOne Platform — Agent Execution Engine](https://www.stackone.com/platform/agent-execution-engine/) — Falcon positioning ("Your Integrations. As Code. No Black Boxes. Just YAML.").
- [StackOneHQ/connectors-template](https://github.com/StackOneHQ/connectors-template) — real connector implementations; MCP-based build setup.
- Totem repo: `README.md`, `src/connector.ts`, `src/action.ts`, `src/actions.ts`, `src/registry.ts`, `src/executor.ts` — ADR-0001/0003/0004/0005 contracts as implemented.

### Dropped
- `connector-building/build-workflow`, `connector-building/github-ci-cd`, `connector-yaml-reference/overview` — duplicate/overlapping with CLI + CI/CD pages already cited.
- `connector-building/rendering-guides`, `connector-building/implementing-events`, `connectors/add-new` — out of scope (guide rendering, webhook events, request forms).
- `connector-building/stackone-cli` — superseded by `cli-reference.md` (identical content).

## Gaps

- **The `stackone-agent.md` page could not be fetched as a standalone page** — the URL resolves to the CLI reference's agent section; the agent's behavior is therefore reconstructed from the CLI reference + first-connector guide (consistent, but the standalone page may contain additional material). Suggested next step: fetch `https://docs.stackone.com/guides/connector-engine/stackone-agent` in a browser session, or check the `connectors-template` repo's `.claude/skills/` contents.
- **Numbers drift across docs**: `llms.txt` header says "400 connectors / 22,000 actions"; the connectors introduction says "470+ / 28,000+"; the engine introduction says "200+ pre-built" connectors run on Falcon. Cited the connectors page as current; verify against the live catalog before quoting in issue/ADR prose.
- **Totem ADR text files could not be located** (guessed `docs/adr/ADR-0003.md`, `0003-*.md` — ENOENT); ADR-0001/0003/0005 content is cited from README + code comments, which are consistent. Confirm ADR file locations before quoting ADR numbers in a new ADR.
- **`@stackone/expressions` and `@stackone/cli` internals** (exact JEXL dialect semantics, merge rules) are documented only via docs + npm; the npm packages are the ultimate reference if edge-case semantics matter.
