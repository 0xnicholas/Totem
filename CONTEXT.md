# Totem

Totem is a multi-tenant action layer for AI agents: a curated, schema-first set of actions over MCP, backed by pluggable connectors to real systems (v1: Feishu Docs), with per-connection allowlists and audit logging. It is an internal platform: tenants are the operator's own internal projects, not paying customers (no SaaS, no second-level customer).

## Language

**Action**:
A platform-defined, schema-first operation (`create_doc`, `search_docs`) with a name, LLM-facing description, input schema, and output schema. The unit of agent capability and the unit of governance.
_Avoid_: Tool, tool call, endpoint, operation

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
The REST projection of an action call (`POST /actions/rpc`, envelope `{action, path, query, body, headers}`) — one of the two consumption surfaces: MCP for agents, RPC for non-agent code (CI, jobs, backend services). A thin adapter over the Execution Boundary: same governance, same error vocabulary, same audit. Never a second semantics.
_Avoid_: REST API, traditional API, endpoint (when the topic is the RPC surface)
