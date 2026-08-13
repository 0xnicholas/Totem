# Totem

Totem is a multi-tenant action layer for AI agents: a curated, schema-first set of actions over MCP, backed by pluggable connectors to real systems (v1: Feishu Docs), with per-connection allowlists and audit logging. It is an internal platform: tenants are the operator's own internal projects, not paying customers (no SaaS, no second-level customer).

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

**Action Registry**:
The single source of truth for action definitions. Owned by the platform; connectors declare which actions they implement.
_Avoid_: Tool registry, action catalog

**Connector**:
The pluggable translation code that implements actions for one real system. A pure translator: unified args → system request, system response → unified output, system errors → unified errors. Never touches governance, storage, or auth state.
_Avoid_: Integration, adapter (when the topic is the connector as a whole), driver

**Connection**:
One tenant's authorized instance of a system: the row that holds OAuth tokens, allowlist, and audit scope for a specific Feishu user. Data, not code. A connector serves many connections.
_Avoid_: Connector (when you mean a connection), account, integration instance

**Tenant**:
The isolation unit of the platform and its unit of consumption: one consuming internal project. Owns connections, API keys, allowlists, and audit rows. Authenticates to the MCP endpoint with a tenant API key. Totem is an internal platform — tenants are the operator's own company's projects, not paying customers; there is no second-level customer (no StackOne-style origin_owner). Totem has no end-user accounts: agents act on behalf of a tenant, and system actions execute with the identity of the connection's owner (the Feishu user who authorized).
_Avoid_: Customer, organization, user, StackOne-style org → project → origin_owner hierarchy

Tenants are **mutually trusted** in v1 (ADR-0010): admin-scope tenant keys are platform-credential equivalent, so consuming projects can self-onboard without an operator ticket. Tenant-scoped admin isolation is deferred until a non-trusted consumer exists.

**App Credentials**:
The OAuth application a tenant registers for a system (v1: a Feishu custom app): app_id/app_secret, held and encrypted by the platform. Registered self-service via the admin API by the tenant's own engineers, never committed to the tenant's codebase. The platform runs the authorize flow with them and stores the resulting tokens per connection.
_Avoid_: Client secrets, OAuth app config, setup fields

**Authorize Flow**:
The minimal OAuth dance that opens a connection: the tenant registers App Credentials, the platform returns an authorize URL, the tenant's user grants access in the system's consent screen, and the callback creates the Connection. Deliberately not a StackOne-style connect session/Hub: no session tokens, no origin_owner, one redirect.
_Avoid_: Connect session, Hub, linking flow

**Allowlist**:
The per-connection list of action names that may be executed. Enforced at the execution boundary; also filters which tools the MCP server advertises to the agent (hide, don't reject).
_Avoid_: Whitelist, permissions, ACL

**Audit Log**:
The append-only record of every execution attempt: tenant, connection, action, param hash, status, error code, timestamp. The answer to "who did what, when".
_Avoid_: Log, traces, events

**Opaque ID**:
The platform-level identifier for a system object (`doc_id`), whose meaning only the connector can parse. Agents reference objects by opaque IDs, never by system tokens.
_Avoid_: Document token, docx token (when exposed to agents), resource URL

**Upstream**:
The external system a connector talks to (v1: Feishu Open Platform). The source of `not_found`, `rate_limited`, and `upstream_error` failures.
_Avoid_: Backend, third-party API, provider

**Execution Boundary**:
The single orchestration point (`executeAction`) through which every action call passes: allowlist check, schema validation, token acquisition, dispatch, audit write. The primary test seam (Seam A).
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
The unified output shape of list actions: `{data, next}` with identity fields (`doc_id`, `range`, `table_name`) kept at the top level. Aligned with StackOne's `actionType: list`; `next` is the cursor, currently always `null` (ADR-0012).
_Avoid_: named list fields (`docs`/`records`/`values` — the ADR-0006 convention, superseded)
