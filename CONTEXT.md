# Totem

Totem is a multi-tenant action layer for AI agents: a curated, schema-first set of actions over MCP, backed by pluggable connectors to real systems (docs: Feishu, DingTalk; messaging send: Feishu, DingTalk, WeCom per ADR-0016), with per-connection allowlists and audit logging. It is an internal platform: tenants are the operator's own internal projects, not paying customers (no SaaS, no second-level customer).

## Language

**Action**:
A platform-defined, schema-first operation (`create_doc`, `search_docs`) with a name, LLM-facing description, input schema, and output schema. The unit of agent capability and the unit of governance.
_Avoid_: Tool, tool call, endpoint, operation

**Canonical Action**:
An Action with no provider scope — any connector may implement it, and the same name across connectors has identical schemas. The default kind; what "Action" meant before ADR-0013.
_Avoid_: Unified action, standard action

**Provider-native Action**:
An Action scoped to one provider (`Action.provider`, ADR-0013): named `<provider>_verb_noun` (e.g. `feishu_read_bitable_records`), implementable only by that provider's connectors, with a curated provider-shaped output schema that keeps every platform invariant (opaque IDs, unified errors, validation). Enters the catalog when a capability is genuinely provider-specific; promoted by adding a new canonical Action and deprecating the native one (ADR-0014) — never by renaming.
_Avoid_: Custom action (StackOne's `custom` actionType returns raw provider output; totem's provider-native output stays curated), connector-specific action, passthrough

**Visible Action**:
An Action with no `hidden` flag — the registry's advertisement view, produced by `ActionRegistry.visibleActions()` (hidden excluded, name-sorted) and projected by every consumption surface (MCP tools, `GET /actions`, OpenAPI). Hidden actions stay registered and executable through the Execution Boundary; they are simply never advertised.
_Avoid_: Public action, exposed action, listed action

**Action Registry**:
The single source of truth for action definitions. Owned by the platform; connectors declare which actions they implement.
_Avoid_: Tool registry, action catalog

**Connector**:
The pluggable translation code that implements actions for one real system. A pure translator: unified args → system request, system response → unified output, system errors → unified errors. Never touches governance, storage, or auth state.
_Avoid_: Integration, adapter (when the topic is the connector as a whole), driver

**Connection**:
One tenant's authorized instance of a system: the row that holds tokens, allowlist, and audit scope — for a specific system user (Feishu, DingTalk) or, for consent-less systems, for the app identity itself (WeCom, ADR-0017). Data, not code. A connector serves many connections.
_Avoid_: Connector (when you mean a connection), account, integration instance

**Credential Connection**:
A Connection of a consent-less system (WeCom): created when the tenant registers App Credentials — no authorize URL, no callback, identity is the app itself, tokens are app-level access tokens served by the cached cell (fetch on expiry, single-flight, never auth-expired). ADR-0017.
_Avoid_: App connection, key connection, bot connection

**Tenant**:
The isolation unit of the platform and its unit of consumption: one consuming internal project. Owns connections, API keys, allowlists, and audit rows. Authenticates to the MCP endpoint with a tenant API key. Totem is an internal platform — tenants are the operator's own company's projects, not paying customers; there is no second-level customer (no StackOne-style origin_owner). Totem has no end-user accounts: agents act on behalf of a tenant, and system actions execute with the identity of the connection — the owner's identity on user-grant systems (the Feishu user who authorized), the app identity where the system only knows applications (DingTalk messaging, WeCom; ADR-0017).
_Avoid_: Customer, organization, user, StackOne-style org → project → origin_owner hierarchy

Tenants are **mutually trusted** in v1 (ADR-0010): admin-scope tenant keys are platform-credential equivalent, so consuming projects can self-onboard without an operator ticket. Tenant-scoped admin isolation is deferred until a non-trusted consumer exists.

**App Credentials**:
The system application a tenant registers (v1: a Feishu custom app; WeCom: a self-built app — corpid/secret/agentid): credentials held and encrypted by the platform. Registered self-service via the admin API by the tenant's own engineers, never committed to the tenant's codebase. The platform runs the authorize flow (user-grant systems) or fetches the app token (credential systems, ADR-0017) and stores the resulting tokens per connection.
_Avoid_: Client secrets, OAuth app config, setup fields

**Authorize Flow**:
The minimal OAuth dance that opens a connection: the tenant registers App Credentials, the platform returns an authorize URL, the tenant's user grants access in the system's consent screen, and the callback creates the Connection. User-grant systems only — consent-less systems (WeCom) have no dance: the connection is created when the tenant registers App Credentials (ADR-0017). Deliberately not a StackOne-style connect session/Hub: no session tokens, no origin_owner, one redirect. The state machine lives in the platform's Token Lifecycle module; providers contribute thin adapters (ADR-0015).
_Avoid_: Connect session, Hub, linking flow

**Token Lifecycle**:
The platform-owned module (`src/oauth/`) behind a connection's OAuth tokens (ADR-0015): the refresh discipline (early-refresh window, single-flight, fail-fast auth-expired marking) and the Authorize Flow state machine, one platform implementation with thin provider adapters (feishu/, dingtalk/); the cached app-token cell for credential connections (WeCom, ADR-0017 — wecom/tokens.ts) is the same module's app-level half, never marking auth-expired. The execution seam stays ADR-0004's one-method `TokenProvider`; provider app-level tokens (DingTalk) are an adapter detail the executor never sees.
_Avoid_: Token manager (when meaning a per-provider copy — there is one platform lifecycle, providers contribute adapters)

**Allowlist**:
The per-connection list of action names that may be executed. Enforced at the execution boundary; also filters which tools the MCP server advertises to the agent (hide, don't reject). Fail-closed: new connections carry an empty allowlist and can do nothing until an operator sets it. Since the destructive family (ADR-0018), a list that includes a destructive action is only accepted with an explicit `allowDestructive: true` acknowledge — destructive actions are never implicitly allowlisted.
_Avoid_: Whitelist, permissions, ACL

**Destructive Action**:
An Action with `effects: 'destructive'` — irreversible upstream state change from the platform's and agent's world (deletion; upstream trash recovery is a human operation, not an agent capability). Carries a class contract (ADR-0018): allowlisted only by acknowledged act, input args screened fail-closed at the boundary (a high-risk Defender detection blocks regardless of `blockHighRisk`), every attempt audited with `metadata.effects` stamped and exempt from error-only mode. MCP projects the class as `destructiveHint`.
_Avoid_: Dangerous action, admin action, irreversible action (when the topic is the effects class)

**Audit Log**:
The append-only record of every execution attempt: tenant, connection, action, param hash, status, error code, timestamp. The answer to "who did what, when".
_Avoid_: Log, traces, events

**Opaque ID**:
The platform-level identifier for a system object (`doc_id`, `chat_id`), whose meaning only the connector can parse. Agents reference objects by opaque IDs, never by system tokens; natural keys an agent already possesses (an email) may enter schemas, but provider-shaped tokens (`open_id`, `user_id`, `union_id`) never do (ADR-0016).
_Avoid_: Document token, docx token (when exposed to agents), resource URL

**Upstream**:
The external system a connector talks to (v1: Feishu Open Platform). The source of `not_found`, `rate_limited`, and `upstream_error` failures.
_Avoid_: Backend, third-party API, provider

**Upstream HTTP Kernel**:
The shared request machinery behind the connectors (`src/upstream-http.ts`): URL + query building, fetch, JSON parsing, the binary download stack (relative path with the profile's auth — an auth header, or a query token for query-param families like WeCom — or an absolute pre-signed URL fetched verbatim with no credentials, both under an optional byte cap), and the network / non-JSON failure vocabulary. Each connector family contributes a profile — the system label, the auth attachment (header name or query param), empty-body policy, and the envelope convention (success check + error mapping, applied to error envelopes on downloads too) — so handlers declare endpoint and response shape only. Connectors stay pure translators (ADR-0003).
_Avoid_: HTTP client, fetch helper

**Execution Boundary**:
The single orchestration point (`executeAction`) through which every action call passes: allowlist check, schema validation, token acquisition, dispatch, audit write. It also answers the tool-list question the surfaces ask (`listAllowedTools` — visible view ∩ allowlist ∩ connector `implements`, ADR-0002 hide-don't-reject), so governance data never crosses a second seam. The primary test seam (Seam A).
_Avoid_: Service layer, use case, controller

**Retryable**:
A property of an error: whether an agent should retry the action. `rate_limited` is retryable; validation and permission errors are not.
_Avoid_: Transient, temporary failure

**MCP Tool**:
The MCP-protocol view of an action. One action may appear as one tool; the mapping is a thin adapter and never changes action semantics.
_Avoid_: Action (when speaking at the MCP layer), tool call

**Actions RPC**:
The REST projection of an action call (`POST /actions/rpc`, envelope `{action, args}`) — one of the two consumption surfaces: MCP for agents, RPC for non-agent code (CI, jobs, backend services). A thin adapter over the Execution Boundary: same governance, same error vocabulary, same audit. Never a second semantics. (StackOne splits `path/query/body/headers` because its registry has parameter positions; totem's schema-first registry has none, so a flat `args` is the canonical shape, ADR-0008.)
_Avoid_: REST API, traditional API, endpoint (when the topic is the RPC surface)

**Consumption Standard**:
The public contract of the consumption surfaces, in two layers: a human-readable contract document (`docs/standards/consumption-standard.md`) and machine-readable OpenAPI (generated from the registry, published at `GET /openapi.json`). Aligned with StackOne's published contract; deliberate deviations are recorded in the standard's diff table. Consumers adjust against the standard, not against the implementation.
_Avoid_: 开放标准 (it is not a standards-organization protocol), API 文档

**List Envelope**:
The unified output shape of list actions: `{data, next}` with identity fields (`doc_id`, `range`, `table_name`) kept at the top level. Aligned with StackOne's `actionType: list`; `next` is the pagination cursor — non-null when more results exist, passed back as the optional `page_token` input (live since #42; providers without cursor support return `null`, a single page) (ADR-0012).
_Avoid_: named list fields (`docs`/`records`/`values` — the ADR-0006 convention, superseded)

**Chat**:
A conversation container in a messaging system, addressed by the opaque `chat_id` — the group-message target of `send_message` (ADR-0016). Created upstream; its internals are never exposed to agents.
_Avoid_: Group, conversation, room
