# StackOne Protocol Surface — Research Brief

**Date:** 2025-xx-xx (research run)
**Repo:** totem (branch: `research/protocols`)
**Question:** How does StackOne expose actions to AI agents — Actions RPC, MCP, A2A, and Toolset SDK surfaces; how does Search & Execute discover actions; what does the unified action contract look like at the protocol layer?

**TL;DR.** StackOne is an "AI Integration Gateway": one canonical catalog of **actions** (e.g. `salesforce_list_contacts`, `gmail_send_message`), and every protocol — REST Actions RPC, MCP, A2A, Agent SDK/Toolset — is a thin adapter over the *same engine and the same action contract* ([Call Actions](https://docs.stackone.com/guides/calling-stackone-actions.md)). Discovery is solved once, in the catalog layer: `GET /actions` (metadata), `POST /actions/search` (semantic search), and an MCP `tool-mode=search_execute` that collapses a huge catalog into two tools (`search_actions` + `execute_action`) so agent context stays flat ([Tool Discovery](https://docs.stackone.com/features/tool-discovery)). The unified action contract at the wire level is a small, stable envelope: Basic-auth + `x-account-id`, `POST /actions/rpc` with `{action, path, query, body, headers}`, a cursor-based `next`/`next_cursor` pagination, and a uniform error model (`statusCode/message/timestamp` + optional `provider_errors` passthrough at REST; `isError` + `error_category` + `retryable` at the MCP tool level) ([RPC OpenAPI](https://docs.stackone.com/platform/api-reference/actions/make-an-rpc-call-to-an-action.md)).

---

## 1. The four protocol surfaces

StackOne documents exactly four ways to invoke actions, and they are interchangeable by design — "All protocols route through the **same engine**, so authentication, rate limiting, data transformation, and error recovery are handled for every action" ([Call Actions](https://docs.stackone.com/guides/calling-stackone-actions.md)). A connector page in the docs states it plainly: *"Use via Actions RPC, Toolset SDK, MCP, or A2A"* ([Connectors](https://docs.stackone.com/connectors/introduction.md)).

### 1.1 Actions RPC / HTTP (REST Actions API)

- **What:** A plain REST surface, no agent or framework required. `POST https://api.stackone.com/actions/rpc` executes any enabled action; `GET /actions` discovers metadata; `POST /actions/search` does semantic search ([RPC/HTTP guide](https://docs.stackone.com/embed/call-actions/rpc-http)).
- **Auth:** HTTP Basic auth with the API key (base64 of `<api_key>:`), plus the linked account's id in the `x-account-id` header. Optional `x-connector-profile-id` header overrides the account's profile for the request ([RPC OpenAPI](https://docs.stackone.com/platform/api-reference/actions/make-an-rpc-call-to-an-action.md)).
- **When used:** Backend jobs (scheduled syncs, data pipelines), triggering actions from app logic, one-off scripts; "full control, non-agentic" ([Call Actions](https://docs.stackone.com/guides/calling-stackone-actions.md), [RPC/HTTP guide](https://docs.stackone.com/embed/call-actions/rpc-http)).
- **Also:** language-native platform SDKs (`@stackone/stackone-client-ts`) wrap this surface ([RPC/HTTP guide — TypeScript SDK tab](https://docs.stackone.com/embed/call-actions/rpc-http)).

### 1.2 MCP (Model Context Protocol)

- **What:** StackOne runs a **pre-built MCP server per linked account** at `https://api.stackone.com/mcp`. One account = one endpoint; switching users is switching the `x-account-id` header. Transport is MCP **Streamable HTTP**: HTTPS only, POST for all operations, no SSE, stateless, JSON-RPC 2.0 messages (`initialize`, `tools/list`, `tools/call`) ([MCP guide](https://docs.stackone.com/embed/call-actions/mcp)).
- **Auth:** Basic auth + `x-account-id` (header or query fallback); the `Accept: application/json,text/event-stream` header is mandatory per the MCP spec (else 406). Token URLs (`https://api.stackone.com/mcp?token=<session_token>`) let user-facing clients connect without the API key leaving the backend ([MCP guide](https://docs.stackone.com/embed/call-actions/mcp)).
- **Tool registration modes** (query param `tool-mode`): `individual` (default — one MCP tool per action, for ≤ ~50 tools) or `search_execute` (exactly two tools: `{provider}_search_actions` + `{provider}_execute_action`) ([MCP guide](https://docs.stackone.com/embed/call-actions/mcp), [MCP JSON-RPC reference](https://docs.stackone.com/platform/api-reference/mcp/send-mcp-json-rpc-message.md)).
- **Param-style knobs:** the raw endpoint also accepts `param-style=nested|flat_prefixed|flat_smart` (how the JSON Schema parameter envelope is shaped) and `instructions=on|off` (whether server instructions teach the model the path/query/body/headers envelope) ([MCP JSON-RPC reference](https://docs.stackone.com/platform/api-reference/mcp/send-mcp-json-rpc-message.md)).
- **When used:** any MCP-compatible client — Claude, Cursor, Windsurf, n8n, Vercel AI, IDE agents; "quick setup, no code (config only)" ([Call Actions](https://docs.stackone.com/guides/calling-stackone-actions.md), [MCP guide](https://docs.stackone.com/embed/call-actions/mcp)).

### 1.3 A2A (Agent2Agent)

- **What:** StackOne exposes a **pre-built A2A agent per linked account** at `https://a2a.stackone.com`, speaking the Linux Foundation's A2A protocol (JSON-RPC over HTTP: `message/send`, `message/stream`, `tasks/get`). Skills are generated from the actions enabled on the account's connector; behind the scenes the agent routes through the same MCP server + actions engine ([A2A guide](https://docs.stackone.com/a2a/introduction.md)). **Open beta** ([A2A guide](https://docs.stackone.com/a2a/introduction.md)).
- **Discovery:** two agent cards — a **public discovery card** at `/.well-known/agent-card.json` (no auth, advertises `supportsAuthenticatedExtendedCard: true`) and an **authenticated extended card** (`/agent/authenticatedExtendedCard`) listing the account's actual skills, each with `id/name/description/tags` (e.g. `hibob_search_employees`, tags `["stackone","hibob"]`) ([A2A guide](https://docs.stackone.com/a2a/introduction.md), [live agent card](https://a2a.stackone.com/.well-known/agent-card.json)).
- **Implementation:** built on Google's ADK (Agent Development Kit) — each request runs an agent on a Gemini model; the StackOne ADK plugin exposes a **search-and-execute tool model** (one tool to search the action catalog, one to execute) so the prompt stays constant-size as connectors are added ([A2A guide](https://docs.stackone.com/a2a/introduction.md)).
- **When used:** multi-agent orchestration, agent platforms (Gemini Enterprise, Microsoft Foundry), long-running async tasks, context isolation; "skip it when you need synchronous responses in a single agent" ([Call Actions](https://docs.stackone.com/guides/calling-stackone-actions.md), [A2A agent platforms](https://docs.stackone.com/embed/call-actions/agent2agent/agent-platforms)).

### 1.4 Agent SDK / Toolset (programmatic tool loading)

- **What:** typed TypeScript (`@stackone/ai`) and Python (`stackone-ai`) SDKs. `StackOneToolSet` fetches tools for an account, filters them (provider globs like `workday_*`, action names/wildcards like `*_list_*`), and hands them to a framework's function-calling loop (OpenAI Functions, Vercel AI SDK, LangChain, CrewAI, LangGraph, Pydantic AI) ([Agent SDK guide](https://docs.stackone.com/embed/call-actions/agent-sdk)).
- **Tool Discovery integration:** the SDK exposes the same search concept as `tool_search` + `tool_execute` (only two tools reach the LLM), plus "manual search" where app code searches the catalog up front, and `fetch_tools()` filtering ([Tool Discovery](https://docs.stackone.com/features/tool-discovery)).
- **When used:** AI agents built with frameworks where you want programmatic control — load, filter, select tools dynamically; "best for programmatic control" ([Call Actions](https://docs.stackone.com/guides/calling-stackone-actions.md), [Agent SDK guide](https://docs.stackone.com/embed/call-actions/agent-sdk)).

### 1.5 Mixing protocols

StackOne explicitly supports mixing: RPC for backend jobs, Agent SDK for product-facing AI, MCP for internal tools, A2A for complex multi-agent workflows — "they all use the same actions and authentication" ([Call Actions](https://docs.stackone.com/guides/calling-stackone-actions.md)). The old sitemap page ([Protocols & SDKs](https://docs.stackone.com/connect/protocols-and-sdks)) now redirects to the same Call Actions docs and declares an API catalog at `/.well-known/api-catalog` (fetching that JSON returned 404 from our tooling — see Gaps).

---

## 2. The unified action contract

### 2.1 Identity & scope (auth model)

- Every call, on every protocol, uses the same two values: **API key** (Basic auth, `<api_key>:` base64-encoded) and **`x-account-id`** (the linked account / end-user scope) ([Call Actions](https://docs.stackone.com/guides/calling-stackone-actions.md), [MCP guide](https://docs.stackone.com/embed/call-actions/mcp)).
- Optional per-request overrides: `x-connector-profile-id` (profile must belong to the same project + connector as the account, else 400) and `debug=true` ([RPC OpenAPI](https://docs.stackone.com/platform/api-reference/actions/make-an-rpc-call-to-an-action.md)).
- A2A additionally supports **multiple accounts in one request** (comma-separated or repeated `x-account-id` headers) with parallel fan-out and per-account routing ([A2A guide](https://docs.stackone.com/a2a/introduction.md)).

### 2.2 Request shape (RPC envelope)

`POST /actions/rpc` body ([RPC OpenAPI](https://docs.stackone.com/platform/api-reference/actions/make-an-rpc-call-to-an-action.md)):

| Field | Type | Notes |
|---|---|---|
| `action` | string (required) | action identifier, e.g. `bamboohr_list_employees`, `greenhouse_create_candidate` |
| `path` | object \| null | path params, e.g. `{"id":"emp_123"}` |
| `query` | object \| null | query params, e.g. `{"page_size":25}`; sub-schema `ActionsRpcQueryDto` adds `debug` |
| `headers` | object \| null | request headers for the action |
| `body` | object \| null | request body for write ops |
| `defender_enabled` | boolean \| null | deprecated — use `defender_config` |
| `defender_config` | object \| null | `{enabled, block_high_risk, use_tier1_classification, use_tier2_classification}` (prompt-injection guard controls) |

The same envelope shows up at the MCP layer: in `search_execute` mode, `execute_action` takes "any action by its `action_id`, with optional `path`, `query`, `body`, and `headers`" ([MCP guide](https://docs.stackone.com/embed/call-actions/mcp)). Note a doc inconsistency: the API-reference JSON-RPC example names the field `action_name` (+ `query_params`) while the guide says `action_id` — a single canonical param name would be cleaner (see Gaps) ([MCP JSON-RPC reference](https://docs.stackone.com/platform/api-reference/mcp/send-mcp-json-rpc-message.md)).

### 2.3 Response shape

- REST RPC 200 is an "Action response"; the SDK examples show `response.json()["data"]` and `rpcActionResponse?.data` — i.e. a `data` array of normalized records ([RPC/HTTP guide](https://docs.stackone.com/embed/call-actions/rpc-http)).
- The MCP `tools/call` success example makes the envelope explicit: `result.content[0].text` = `{"isError":false,"result":{"data":[{...}],"next_cursor":null}}` with parallel `structuredContent` ([MCP JSON-RPC reference](https://docs.stackone.com/platform/api-reference/mcp/send-mcp-json-rpc-message.md)).
- Tools are *not* raw provider wrappers: "Many are mapped to high-value, context-optimized actions tailored to common business use cases" ([MCP guide](https://docs.stackone.com/embed/call-actions/mcp)) — an action can be a composite, not a 1:1 endpoint mirror.

### 2.4 Error model

Two complementary layers:

**REST/HTTP errors** (OpenAPI, uniform across all Actions endpoints) ([List actions metadata OpenAPI](https://docs.stackone.com/platform/api-reference/actions/list-all-connectors-actions-metadata.md)):
- Base shape: `{ statusCode, message, timestamp }` (400–502 family).
- 400 additionally carries `data` (`UnifiedError`: `{statusCode, message, headers}` — includes `x-request-id`) and `provider_errors`: array of `ProviderError` `{status, url, raw, headers}` — **the raw upstream error is passed through, not swallowed**.
- 429 Too Many Requests and 408 Request Timed Out include a `Retry-After` header.

**Tool-level errors (MCP)** — tool failures are *results*, not JSON-RPC errors: `isError: true` with `result: {"error": "...", "status_code": 404, "error_category": "not_found", "retryable": false}`. Protocol-level failures use JSON-RPC `error {code, message, data}` (e.g. `-32600 Invalid request`) ([MCP JSON-RPC reference](https://docs.stackone.com/platform/api-reference/mcp/send-mcp-json-rpc-message.md)).

**Rate limiting & retries** ([Rate Limiting](https://docs.stackone.com/guides/rate-limiting.md)):
- API keys are limited to **1000 requests/minute**; 429 + `Retry-After` (seconds).
- Provider-side 429s are auto-retried up to **5 attempts** honoring the provider's `Retry-After`; if retries exceed the **60-second request lifetime**, a 408 is returned with a `Retry-After`.

### 2.5 Pagination

Cursor-based, consistently:
- `GET /actions`: `page_size` (default 25), `next` ("the unified cursor"); response `ActionsMetaPaginated { next, data[] }` ([List actions metadata OpenAPI](https://docs.stackone.com/platform/api-reference/actions/list-all-connectors-actions-metadata.md)).
- RPC/tool results: `next_cursor` in the response envelope ([MCP JSON-RPC reference](https://docs.stackone.com/platform/api-reference/mcp/send-mcp-json-rpc-message.md)); the `tools/list` inputSchema example itself shows `query.page_size` + `query.next_cursor` — **pagination is part of the tool's JSON Schema** ([MCP JSON-RPC reference](https://docs.stackone.com/platform/api-reference/mcp/send-mcp-json-rpc-message.md)).

### 2.6 Action metadata & discovery

**`GET /actions` — "List all connectors & actions metadata"** ([OpenAPI](https://docs.stackone.com/platform/api-reference/actions/list-all-connectors-actions-metadata.md)):
- Params: `page_size`, `next`, `group_by` (default `connector`), `filter[connectors]`, `filter[account_ids]`, `filter[action_key]`, `include` (`action_details` | `authentication_guides` | `event_guides`), `search` (text across provider names, action labels, descriptions), `exclude=actions`.
- `ActionsMeta` (per connector/profile): `account_id`, `connector_profile_id`, `version`, `name`, `key`, `icon`, `description`, `release_stage` (`ga`/`beta`/`preview` — orgs only see `ga` by default), `categories`, `authentication[]`, `scope_definitions[]`, `actions[]`, `event_actions[]`.
- `ActionMetaItem`: `id`, `label`, `description`, `schema_type`, `syncable`, `supports_incremental`, `has_required_parameters`, `tags`, `authentication[]`, `required_scopes`, and `action_details` (the action's parameter/response schema, returned when `include=action_details`).

**Semantic search — `POST /actions/search`** ([OpenAPI](https://docs.stackone.com/platform/api-reference/actions/search-connector-actions-by-semantic-similarity.md)):
- Body: `query` (required), `connector` (filter), `top_k` (default 100, range 1–500), `min_similarity` (default 0.4, range 0–1).
- Response: `{ results: [{id, similarity_score}], total_count, query, connector_filter, project_filter }`.
- `id` is in "Lambda format": `{connector}_{version}_{connector}_{action}_{scope}`, e.g. `slack_1.0.0_slack_send_message_global` — the versioned search id differs from the friendly tool name (`slack_send_message`). **Search ids are version-scoped; tool names are stable.** Results are filtered to the account's configured/enabled actions (account-aware) ([Tool Discovery](https://docs.stackone.com/features/tool-discovery)).

### 2.7 Search & Execute (how discovery works at runtime)

Motivation: loading hundreds of tool definitions burns tokens, hurts selection accuracy, and hits provider caps (OpenAI ~128 function definitions/request). Search & Execute collapses the catalog to **two tools** ([Search & Execute](https://docs.stackone.com/optimize/search-and-execute)):

1. **`search`** — natural-language query → ranked matching actions with `action_id` + similarity score.
2. **`execute`** — run the chosen action by id with its params.

- **MCP:** `?tool-mode=search_execute` registers `{provider}_search_actions` (query, `top_k` default 10 / max 50) and `{provider}_execute_action`. The agent **must** search first; ids are discovered at runtime, never hardcoded ([MCP guide](https://docs.stackone.com/embed/call-actions/mcp)).
- **SDK:** `tool_search` + `tool_execute` handed to the LLM; or manual search by app code; or `fetch_tools()` filters ([Tool Discovery](https://docs.stackone.com/features/tool-discovery)).
- **REST:** `POST /actions/search` then `POST /actions/rpc` ([Tool Discovery](https://docs.stackone.com/features/tool-discovery)).
- **Search internals:** embeddings are enriched — "action descriptions are expanded with related terms before embedding, so 'onboard new hire' matches 'Create Employee'". Benchmarks across 103 semantically-challenging queries / 9,340 actions: BM25 (local) Hit@5 21% all-connectors / 65% per-connector; enriched-embedding semantic 84% / 90% ([Tool Discovery](https://docs.stackone.com/features/tool-discovery)).
- **Governance:** connector-profile scoping sets hard admin boundaries; Search & Execute operates within them. Project Settings → MCP Settings → Search & Execute can be *allowed / let the connecting user choose / enforced for all connections* ([Search & Execute](https://docs.stackone.com/optimize/search-and-execute)).
- **Token math (illustrative):** 500 individual tools ≈ 150k tokens vs 2 search-execute tools ≈ 900 tokens ([Search & Execute](https://docs.stackone.com/optimize/search-and-execute)).

### 2.8 A2A skill metadata

A2A discovery reuses the same catalog: skills in the authenticated extended card are `{id, name, description, tags}` generated from the account's enabled actions; the live public card advertises `protocolVersion 0.3.4`, `supportsAuthenticatedExtendedCard: true`, OAuth2 security scheme (scopes `mcp` + `offline_access`), and `streaming`/`stateTransitionHistory` capabilities ([live agent card](https://a2a.stackone.com/.well-known/agent-card.json), [A2A guide](https://docs.stackone.com/a2a/introduction.md)).

---

## 3. What totem can adopt (MCP-first + schema-first registry, spec decision D4)

Mapping StackOne's design onto totem's model (per [CONTEXT.md](/CONTEXT.md): Action Registry = single source of truth; Connector = pure translator; Connection = tenant's authorized instance; Allowlist; Audit Log; Retryable; MCP Tool = thin adapter view of an action):

1. **Search & Execute as the default MCP tool-mode.** Register exactly two tools (`tool_search`/`tool_execute`) at the MCP layer regardless of catalog size; keep `individual` mode as an option for small allowlists (< ~50 tools). This is exactly totem's "hide, don't reject" allowlist philosophy applied at the protocol layer ([MCP guide](https://docs.stackone.com/embed/call-actions/mcp), [Search & Execute](https://docs.stackone.com/optimize/search-and-execute)).
2. **Schema-first registry is the substrate every surface reads from.** StackOne's `GET /actions` metadata (id, label, description, schema, tags, required_scopes, release_stage) is the same source that feeds MCP `tools/list` JSON Schemas, A2A skill cards, and the RPC envelope ([List actions metadata OpenAPI](https://docs.stackone.com/platform/api-reference/actions/list-all-connectors-actions-metadata.md)). Totem's Action Registry should own: action id, LLM-facing description, input/output schemas, tags, scopes — and *derive* (a) MCP tool schemas, (b) A2A skill cards, (c) REST docs from it.
3. **One action contract, multiple parameter-style projections.** StackOne's `param-style=nested|flat_prefixed|flat_smart` and `instructions=on|off` show that a single canonical schema can be projected into different agent-facing envelopes without changing semantics — the right pattern for a protocol-agnostic registry ([MCP JSON-RPC reference](https://docs.stackone.com/platform/api-reference/mcp/send-mcp-json-rpc-message.md)).
4. **Stable tool names vs versioned search ids.** StackOne distinguishes the friendly `provider_action` tool name from the version-scoped Lambda search id (`slack_1.0.0_slack_send_message_global`) ([Search OpenAPI](https://docs.stackone.com/platform/api-reference/actions/search-connector-actions-by-semantic-similarity.md)). Totem's registry should version action *definitions* while keeping the agent-facing action name stable — the name is the governance unit, the version is the schema unit.
5. **Unified error taxonomy with `retryable`.** StackOne's `error_category` + `retryable` at the tool layer and `provider_errors` passthrough at REST map directly onto totem's `not_found`/`rate_limited`/`upstream_error` and its `Retryable` concept ([CONTEXT.md](/CONTEXT.md), [MCP JSON-RPC reference](https://docs.stackone.com/platform/api-reference/mcp/send-mcp-json-rpc-message.md), [List actions metadata OpenAPI](https://docs.stackone.com/platform/api-reference/actions/list-all-connectors-actions-metadata.md)). Adopt: tool-level errors as results (`isError`), not protocol errors; `retryable` computed by the connector translator; `Retry-After` surfaced on 429/408.
6. **Cursor pagination in the schema.** `page_size` + `next`/`next_cursor` as first-class schema fields (default 25) — matches totem's list actions and keeps agents honest about pagination ([List actions metadata OpenAPI](https://docs.stackone.com/platform/api-reference/actions/list-all-connectors-actions-metadata.md), [MCP JSON-RPC reference](https://docs.stackone.com/platform/api-reference/mcp/send-mcp-json-rpc-message.md)).
7. **Semantic search with local fallback.** `auto` mode (semantic API first, BM25/TF-IDF in-process fallback), `min_similarity` threshold (0.4 default), `top_k` caps, and enriched descriptions (expand with related terms before embedding) are directly reusable for totem's registry search ([Tool Discovery](https://docs.stackone.com/features/tool-discovery), [Search OpenAPI](https://docs.stackone.com/platform/api-reference/actions/search-connector-actions-by-semantic-similarity.md)).
8. **A2A as a derived surface, not a second catalog.** Public discovery card + per-tenant authenticated extended card generated from the registry; skills = enabled actions, tags = `["stackone", "<connector>"]` style ([A2A guide](https://docs.stackone.com/a2a/introduction.md), [live agent card](https://a2a.stackone.com/.well-known/agent-card.json)).
9. **Admin-scoped boundaries at the connection/profile level, protocol-level narrowing within them.** StackOne's connector-profile scoping (allowlist of enabled actions) is the hard boundary every protocol inherits; Search & Execute only narrows within it — same two-tier model as totem's Allowlist + per-connection tool advertisement ([Search & Execute](https://docs.stackone.com/optimize/search-and-execute)).

---

## 4. Verdict: is a REST Actions RPC surface worth totem v2?

**Yes — but only as the shared substrate beneath MCP, not as a parallel surface with divergent semantics.**

Evidence for:
- **StackOne treats REST as the floor, not an afterthought.** "You don't need an agent to use a connector. Any backend, script, or workflow can call an action directly over the Actions API" ([RPC/HTTP guide](https://docs.stackone.com/embed/call-actions/rpc-http)). MCP, A2A, and the Agent SDK all "route through the same engine and actions" — in StackOne's architecture the REST Actions API *is* the engine; MCP is an adapter over it ([MCP guide](https://docs.stackone.com/embed/call-actions/mcp), [A2A guide](https://docs.stackone.com/a2a/introduction.md)).
- **Non-agentic consumers are real.** Backend jobs, syncs, scripts, no-code, and plain SDK use are an explicitly documented protocol slot with a full comparison table ([Call Actions](https://docs.stackone.com/guides/calling-stackone-actions.md)). A totem v2 that is MCP-only would have no answer for those callers.
- **It's nearly free once the registry + executor exist.** The action contract (`{action, path, query, body, headers}`), the error taxonomy, and the cursor pagination are already defined at the registry/execution boundary ([CONTEXT.md](/CONTEXT.md) — `executeAction` is "the single orchestration point"). A thin REST envelope over `executeAction` is adapter work, the same adapter work MCP already requires. StackOne's own REST `POST /actions/rpc` body is literally the MCP `tools/call` arguments minus the wrapper ([RPC OpenAPI](https://docs.stackone.com/platform/api-reference/actions/make-an-rpc-call-to-an-action.md), [MCP JSON-RPC reference](https://docs.stackone.com/platform/api-reference/mcp/send-mcp-json-rpc-message.md)).
- **Stability hedge.** MCP is evolving and A2A is open beta ([A2A guide](https://docs.stackone.com/a2a/introduction.md)); a stable REST surface is the protocol-agnostic floor that survives client churn.

Caveats / counter-arguments:
- **Don't build it as a second product surface.** The failure mode is a REST API that drifts from the MCP tool schemas (different param names, different errors). StackOne avoids this by construction: one engine, adapters over it. Totem should adopt the same rule — the registry is canonical; the REST surface and the MCP server are both projections of it.
- **Sequencing:** for v2, expose REST read-only first (metadata + search: `GET /actions`-equivalent and `POST /actions/search`), which is what makes Search & Execute and registry tooling testable without an agent; add `POST /actions/rpc` once the MCP adapter proves the envelope. Both cost little, but discovery endpoints have the highest immediate value for a schema-first registry.
- **Surface area cost:** two transports = two auth paths (Basic for REST, MCP auth for MCP), rate limiting (StackOne: 1000 req/min/key), and audit hooks. Keep them sharing the same key, tenant scoping (`x-account-id`-equivalent → totem's connection/tenant), and audit log ([Rate Limiting](https://docs.stackone.com/guides/rate-limiting.md)).

**Bottom line:** adopt REST Actions RPC in totem v2 as the canonical execution substrate with MCP (and later A2A) as adapters over the same `executeAction` boundary — matching StackOne's proven architecture — rather than as an independent "traditional API" with its own semantics.

---

## Sources

- Kept:
  - [Call Actions (protocols overview)](https://docs.stackone.com/guides/calling-stackone-actions.md) — the four surfaces, comparison table, mixing guidance.
  - [RPC/HTTP guide](https://docs.stackone.com/embed/call-actions/rpc-http) — REST workflow, request params, SDK/curl examples.
  - [Make an RPC call to an action (OpenAPI)](https://docs.stackone.com/platform/api-reference/actions/make-an-rpc-call-to-an-action.md) — full RPC request DTO, Defender config, error schemas.
  - [List all connectors & actions metadata (OpenAPI)](https://docs.stackone.com/platform/api-reference/actions/list-all-connectors-actions-metadata.md) — `GET /actions` params, `ActionsMeta`/`ActionMetaItem`, pagination, error model.
  - [Search connector actions by semantic similarity (OpenAPI)](https://docs.stackone.com/platform/api-reference/actions/search-connector-actions-by-semantic-similarity.md) — search DTO/response, Lambda-format ids, similarity scores.
  - [MCP guide](https://docs.stackone.com/embed/call-actions/mcp) — Streamable HTTP, tool modes, token URLs, headers.
  - [Send MCP JSON-RPC message (OpenAPI)](https://docs.stackone.com/platform/api-reference/mcp/send-mcp-json-rpc-message.md) — raw `/mcp` endpoint: `tool-mode`, `param-style`, `instructions`, response/error envelopes, `error_category`/`retryable`.
  - [A2A guide](https://docs.stackone.com/a2a/introduction.md) — agent cards, message/send, tasks, ADK implementation, open beta.
  - [Live A2A agent card](https://a2a.stackone.com/.well-known/agent-card.json) — protocol version, security schemes, skill structure.
  - [Agent SDK guide](https://docs.stackone.com/embed/call-actions/agent-sdk) — ToolSet, filters, framework integrations.
  - [Tool Discovery](https://docs.stackone.com/features/tool-discovery) — search/execute vs filtering vs manual search, benchmarks, search options.
  - [Search & Execute](https://docs.stackone.com/optimize/search-and-execute) — token math, project-level settings, example flows.
  - [Rate Limiting](https://docs.stackone.com/guides/rate-limiting.md) — 1000 req/min, Retry-After, auto-retry policy.
  - [Connectors](https://docs.stackone.com/connectors/introduction.md) — catalog scale claims ("470+ connectors and 28000+ actions").
  - [StackOne homepage](https://www.stackone.com/) — positioning: gateway for AI agents, MCP/A2A/API, Tool Discovery marketing, governance features.
  - [llms.txt index](https://docs.stackone.com/llms.txt) — full doc index used to locate pages.
- Dropped:
  - [guides/overview.md](https://docs.stackone.com/guides/overview.md) — dashboard navigation page, not protocol-relevant.
  - [guides/introduction.md](https://docs.stackone.com/guides/introduction.md) — quickstart (connector profile + account linking), background only.
  - [guides/explore-connectors.md](https://docs.stackone.com/guides/explore-connectors.md) — connector list page (data-heavy; counts already captured from connectors/introduction).
  - [www.stackone.com/blog/mcp-token-optimization/](https://www.stackone.com/blog/mcp-token-optimization/) — marketing framing, redundant with docs.

## Gaps

- **RPC 200 response schema** is an external `$ref` (UUID) in the OpenAPI, not inlined — the exact REST response object beyond `data[]`/`next_cursor` could not be verified from docs alone (inferred from SDK examples and MCP example envelopes).
- **`/.well-known/api-catalog`** (declared by docs pages) returned 404 to our fetcher — likely needs specific headers or a different path (`api-catalog.json`?); the "declared links" mechanism itself is notable for agent discoverability.
- **Doc inconsistencies observed:** connector/action counts differ across pages (400/22,000 in one page vs 470+/28,000+ in the index header); `search_execute` execute-tool param named `action_id` in the guide but `action_name`+`query_params` in the JSON-RPC examples; tool names shown as `{provider}_search_actions` in the guide vs `{provider}_<account_id>_search_actions` in the API reference examples.
- **No public taxonomy of `error_category` values** beyond the `not_found` example — totem should define its own enumerated set (matching its `not_found`/`rate_limited`/`upstream_error` language).

## Suggested next steps

1. Decide totem v2 REST surface: adopt the StackOne envelope (`{action, path, query, body, headers}` + `x-account-id`-style tenant header) as the canonical `executeAction` HTTP projection.
2. Spec the registry metadata shape modeled on `GET /actions` (id, label, description, schema, tags, scopes, version, release_stage) — this becomes the source for MCP schemas and A2A skill cards.
3. Prototype `tool_search`/`tool_execute` MCP mode with the `param-style` projection idea in mind (schema-first → nested/flat projections from one canonical schema).
4. Validate the `not_found`-style error envelope (`isError`, `error_category`, `retryable`) against totem's existing error language.
