# Research: StackOne connections, governance, and observability

**Scope:** How StackOne handles connection methods (Hub UI, auth link, API keys), OAuth app management, projects/API keys, roles/SSO/MFA, audit & request logs, webhooks, and Defender (prompt-injection scanning of tool responses). Sources: `docs.stackone.com` guides fetched 2026-08 (index: [llms.txt](https://docs.stackone.com/llms.txt)). Totem comparison baseline: [spec issue #1](https://github.com/0xnicholas/totem/issues/1), ADRs [0001](https://github.com/0xnicholas/totem/blob/main/docs/adr/0001-platform-defined-actions.md)–[0005](https://github.com/0xnicholas/totem/blob/main/docs/adr/0005-unified-error-vocabulary.md), [CONTEXT.md](https://github.com/0xnicholas/totem/blob/main/CONTEXT.md).

---

## 1. Connection lifecycle — methods, Hub, auth link, account status

### 1.1 Three connection methods

StackOne calls an end-user's authorized connection a **Linked Account** ("one end-user's authenticated connection to one provider"; StackOne stores the credentials). [accounts-section.md](https://docs.stackone.com/guides/accounts-section.md)

| Method | What it is | Best for |
|---|---|---|
| **Embedded Hub** | A `@stackone/hub` React component or `<stackone-hub>` web component embedded in your app, fully themed to your brand. | Production apps (in-app, branded flow). [embedding-stackone-hub.md](https://docs.stackone.com/guides/embedding-stackone-hub.md) |
| **Auth Link** | A StackOne-hosted page with the Hub pre-embedded; you share just a URL. No frontend work. | Email flows, sales-led onboarding, demos. [auth-link.md](https://docs.stackone.com/guides/auth-link.md) |
| **Dashboard linking** | Link accounts manually from the StackOne dashboard (ops/support on a customer's behalf, internal tools). | Internal tools, no-code. [linking-accounts.md](https://docs.stackone.com/connect/managing-connectors/linking-accounts.md) |

### 1.2 The connect-session flow (Hub + Auth Link both use it)

1. Your backend calls `POST /connect_sessions` with the API key and creates a **connect session** — a short-lived token authorizing one end-user to link an account. The API key never reaches the frontend. [connect-session.md](https://docs.stackone.com/embed/connect-session.md)
2. The Hub (embedded or via Auth Link) consumes the token; the end-user picks a connector and authenticates (OAuth, API key, or basic auth depending on the connector profile). [embedding-stackone-hub.md](https://docs.stackone.com/guides/embedding-stackone-hub.md)
3. On success the **account ID** is returned via callback/event or the `account.created` webhook. [embedding-stackone-hub.md](https://docs.stackone.com/guides/embedding-stackone-hub.md)

Required session fields: `origin_owner_id` (your identifier for the customer's org — **must be set server-side**; "Never pass it through from a client-side request, or a customer could claim another customer's linked accounts"), `origin_owner_name`; optional `origin_username`, `categories` (filter connectors shown in Hub), `expires_in` (seconds), `connector_profile_id` (route the session to a specific profile/version). [connect-session.md](https://docs.stackone.com/embed/connect-session.md)

The `origin_owner_id + origin_owner_name + provider` combination decides create-vs-update: unknown → new account; known → open in edit mode; known + `account_id` → that account; `multiple: true` (no `account_id`) → force new account even if one exists (e.g. one customer, several accounts per provider). [connect-session.md](https://docs.stackone.com/embed/connect-session.md)

Auth Links are generated from the dashboard (fields: origin owner ID/name/username, optional connector filter, connector profile, link expiry default 30 days) or programmatically — the connect-session response contains an `auth_link_url`. Auth Links have **no frontend callback**, so `account.created` webhook is how you know linking succeeded. [auth-link.md](https://docs.stackone.com/guides/auth-link.md)

### 1.3 Account status

| Status | Meaning |
|---|---|
| **Active** | Credentials valid; serving calls. |
| **Suspended** | Manually paused; no actions can run. Credentials stay saved, resume without re-auth. |
| **Error** | Calls failing — usually expired credentials or revoked provider access; re-authenticate to recover. |

StackOne recommends subscribing to `account.updated` / `account.deleted` webhooks instead of polling status. [accounts-section.md](https://docs.stackone.com/guides/accounts-section.md)

### 1.4 Addressing accounts at the MCP layer

StackOne MCP is "one linked account = one server endpoint": every request carries `Authorization: Basic <base64(apiKey:)>` plus an `x-account-id` header (or `?x-account-id=` fallback); switching users is switching the header. The MCP server dynamically generates the tool catalog from the account's connector profile + enabled actions. [mcp/auth-security.md](https://docs.stackone.com/mcp/auth-security.md)

---

## 2. Tenant model — projects, API keys, OAuth apps, connector profiles

### 2.1 Organization → Projects hierarchy

The account is an **organization** containing **projects**. Members and security are org-level; "everything you build with lives in a project." [managing-projects.md](https://docs.stackone.com/guides/managing-projects.md)

Each project has: a mutable **name**; a **region** fixed at creation (data residency; appears in the API key as `v1.{region}.xxxxx`); **API keys scoped to one project** ("a production key can't reach dev data"); **project members** with project-level roles; and its own **connector profiles + linked accounts**. Only Org Admins create projects. Deleting a project is immediate and irreversible — removes linked accounts, API keys, webhooks, and all associated data. [managing-projects.md](https://docs.stackone.com/guides/managing-projects.md)

Regions: Ireland (AWS eu-west-1), Belgium (GCP europe-west1), US N. Virginia (AWS us-east-1), others on request. [managing-projects.md](https://docs.stackone.com/guides/managing-projects.md)

**Multi-tenant accounts**: within one project, `origin_owner_id` segments end-customers — accounts are listed/filtered by `GET /accounts?origin_owner_id=...&provider=...&status=...`. Projects isolate at a higher level (region/environment); origin_owner isolates customers inside a project. Onboarding a customer requires no per-account setup: they self-link against pre-configured profiles. [multi-tenant-accounts.md](https://docs.stackone.com/features/multi-tenant-accounts.md)

### 2.2 API keys

- Authenticate every backend call; **scoped to a single project**. Created in Project Settings → API Keys; label can't change later; key shown **once** — store in a secrets vault, never commit to source control. [api-keys.md](https://docs.stackone.com/guides/api-keys.md)
- **Scopes** set at creation:

| Scope | Default | Grants |
|---|---|---|
| Platform API | Read + Write | Account management, connect sessions, connector profiles |
| Actions | Execute | Interact with actions via RPC and MCP |
| Connectors | Read | Custom connector registry (Write = push/delete) |
| Credentials | Off | Read-only retrieval of stored provider credentials (CLI, running actions outside platform) |
| Unified API | Read + Write | Legacy unified endpoints |

- **Key management**: enable / disable / delete at any time; `Last used` column for spotting stale keys. Recommended AI-agent key set: Platform API Read + Actions Execute + Connectors Read + Credentials Read. [api-keys.md](https://docs.stackone.com/guides/api-keys.md)

### 2.3 OAuth app management

You can use **StackOne's shared OAuth credentials** or **register your own OAuth apps** per provider:

- Shared credentials: fine for internal tools, your own accounts, testing/POC. Not recommended for production with end-customers (consent screen shows StackOne's name; shared rate limits — "one customer's bulk sync can exhaust limits for everyone"). [using-your-own-oauth-apps.md](https://docs.stackone.com/guides/using-your-own-oauth-apps.md)
- Own apps: required for marketplace listings (HubSpot, Zendesk, Microsoft, Atlassian, Salesforce, Google all reject shared credentials), your brand on the consent screen, verification badges, dedicated rate limits, direct console access. Redirect URI format: `https://api.stackone.com/connect/oauth2/{provider}/callback`. Configure Client ID/Secret on the connector profile. **Register early — provider verification can take weeks.** [using-your-own-oauth-apps.md](https://docs.stackone.com/guides/using-your-own-oauth-apps.md)

### 2.4 Connector profiles

A **connector profile** is the per-project configuration for one connector: **authentication type** (OAuth / API Key / Basic Auth, per connector), **credentials** (e.g. Client ID/Secret), **enabled actions**, **enabled events**. Multiple profiles per connector are allowed (OAuth profile for some accounts, API-key profile for others); the default profile decides which auth fields appear in the Hub. [connector-profiles.md](https://docs.stackone.com/guides/connector-profiles.md)

**Connector versioning** (semver, pinned per profile): profiles resolve to latest custom version else latest StackOne version; pins: `latest`, `1.x.x`, `1.2.x`, `1.2.0` (exact), or no pin. **Major = breaking** — auth changes (new flow, required scopes), response/request shape changes, removed actions, behavioral changes; these require linked accounts to **re-authenticate**, migrated via a new profile pinned to the new major + connect sessions routed to it. Immutable versioning (versions locked once published) is on by default (Project Settings → Danger Zone). Recommended production pin: `1.x.x`, not `latest`. [connector-versioning.md](https://docs.stackone.com/guides/connector-versioning.md)

---

## 3. Governance — roles, SSO/MFA, permissions

### 3.1 Roles

**Org roles** (2): **Org Admin** — manages members/security, creates and accesses any project; **Basic** — only projects they're added to (Team Members section hidden). Org and project roles are independent: a Basic member can be Project Admin on one project. [managing-your-organization.md](https://docs.stackone.com/guides/managing-your-organization.md)

**Project roles** (3), assigned per project in Project Settings → Team Members [managing-your-organization.md](https://docs.stackone.com/guides/managing-your-organization.md):

| Resource | Project Admin | Member | Viewer |
|---|---|---|---|
| Linked accounts | Link/edit/re-auth/suspend/delete any account | Link own accounts, manage those | View status and details |
| Connector profiles | Create, configure, scope actions/events, delete | View auth type + enabled actions | Same as Member |
| Request logs | View | View own + shared accounts | View |
| API keys | Create, scope, revoke | None | None |
| Webhooks | Create, route, delete | None | None |
| Project settings | Manage all | None | None |

**Per-account sharing** (on a single linked account): **Admin** — run actions, edit, delete, re-auth, manage access; **Member** — run actions only. "Member" is the model for rolling agent access out to a team: each member connects their own accounts and can only grant an agent the accounts they linked. [managing-your-organization.md](https://docs.stackone.com/guides/managing-your-organization.md)

**Action scoping** (closest analog to totem's allowlist, but at profile level): each connector profile has an Actions tab with per-action toggles; changes apply to every linked account on the profile. [scoping-connectors.md](https://docs.stackone.com/secure/scoping-connectors.md)

### 3.2 MFA

Per-user TOTP (any authenticator app). **Org-wide enforcement** toggle under Organization → Security: enforces MFA for all current and future members. Admins can reset another user's MFA and unlock accounts locked by failed logins; disable (revoke access, keep account) vs delete (permanent). [managing-your-organization.md](https://docs.stackone.com/guides/managing-your-organization.md)

### 3.3 SSO

**SAML 2.0**, org-level. Flow: copy StackOne's **ACS URL + SP Entity ID** (derived from your chosen Provider ID); configure the IdP (Okta walkthrough provided); register IdP Issuer/SSO URL/X.509 cert; **verify your email domain** via a DNS TXT record (`_stackone-sso-verification-token-{providerId}`); then users with matching email domains auto-redirect to the IdP. IdP-initiated sign-in supported. Only Org Admins can configure SSO; feature must be enabled by StackOne support. Deleting SSO forces users back to email/password. [sso-setup.md](https://docs.stackone.com/guides/sso-setup.md)

### 3.4 Security logs

**Security logs** (org level) record "every login attempt, success or failure, for monitoring and audit." [managing-your-organization.md](https://docs.stackone.com/guides/managing-your-organization.md) There is no dedicated "audit log" guide in the docs index — StackOne's audit story is **security logs (who logged in) + request logs (what API calls happened)**. [llms.txt](https://docs.stackone.com/llms.txt), [observability.md](https://docs.stackone.com/secure/observability.md)

---

## 4. Observability — audit logs, request logs, webhooks

### 4.1 Two log levels

| Log | Level | Covers |
|---|---|---|
| Security logs | Organization | Every login attempt, success or failure |
| Request logs | Project | API and webhook requests, status + payload detail for debugging |

[observability.md](https://docs.stackone.com/secure/observability.md)

### 4.2 Request logs

- Show **all requests made to StackOne** **and** all requests StackOne made to **underlying providers** to fulfill them. Dashboard filters: Account (`origin_owner_name`), Provider, Resource, **Source** (`API Request`, `Dashboard UI`, `Webhook`, `Test Connection`, `Other`), Status (HTTP code), Method, Start/End time. Detail view has two tabs: **Details** (request/response headers, body, query params, status) and **Underlying Requests** (the provider API calls behind one unified request). [request-logs.md](https://docs.stackone.com/guides/request-logs.md)
- **Retention: 90 days** after the request; configurable per project. [request-logs.md](https://docs.stackone.com/guides/request-logs.md), [observability-sync.md](https://docs.stackone.com/api/observability-sync.md)
- **Advanced Logs** (Project Settings) is **off by default** — detailed request logging starts only when enabled. Per-project controls: **retention length** and **error-only mode** (store only responses with HTTP status ≥ 400). Retention changes apply only to new logs. [observability.md](https://docs.stackone.com/secure/observability.md)
- **Programmatic access**: Logs API (`GET /requests/logs`, cursor pagination, filters by date/status/account/provider). Log entry fields include `requestId`, `accountId`, `provider`, `service`, `action`, `resource`, `httpMethod`, `path`, `url`, `status`, `success`, `duration`, `eventDatetime`, plus request/response detail. Export paths: Grafana direct polling (Infinity), push sync worker (Temporal/Lambda/cron), webhooks. [observability-sync.md](https://docs.stackone.com/api/observability-sync.md)
- **Error Explainer** (AI feature): generates resolution steps from error logs; needs Advanced Logs enabled; toggle per project under AI Settings. [request-logs.md](https://docs.stackone.com/guides/request-logs.md)

### 4.3 Webhooks

Model: a **webhook** is the outbound HTTPS endpoint; an **event** is what gets delivered. Two config points, both required: the webhook must exist (Webhooks page: URL, signing secrets, delivery health, volume), and events are enabled/routed on the **connector profile**. [webhooks.md](https://docs.stackone.com/guides/webhooks.md)

- **Event categories**: connector events (programmatic — StackOne provisions the subscription per linked account automatically; or manual — a Native Webhook URL you paste into the connector's app config), **platform events** (account lifecycle: `account.created`, `account.updated`, `account.deleted` — subscribed on the webhook itself), and legacy unified events. [webhooks.md](https://docs.stackone.com/guides/webhooks.md), [handle-account-events.md](https://docs.stackone.com/embed/handle-account-events.md)
- **Signing**: every delivery is HMAC-SHA256 over the **raw request body** (not re-serialized JSON), base64url, in the `x-stackone-signature` header; verify with `timingSafeEqual` (constant-time). **Dual-secret rotation**: add a second secret (inactive), verify either, activate the new one, delete the old. Endpoint must return 200 quickly; response body ignored. [webhooks.md](https://docs.stackone.com/guides/webhooks.md)
- Account event payload carries `event`, `account_id`, `provider`, and the `origin_*` identifiers. [handle-account-events.md](https://docs.stackone.com/embed/handle-account-events.md)
- Real-time alert events: `account.error`, `account.expired`, `request.failed`. [observability-sync.md](https://docs.stackone.com/api/observability-sync.md)

---

## 5. Defender — what it scans, how it works

**What:** "Protect your AI agents from prompt injection attacks by scanning API tool call responses before they reach your LLM." Data from third-party providers (emails, CRM records, documents) can contain instructions designed to hijack the agent; Defender intercepts and classifies responses, and can block high-risk content. [defender.md](https://docs.stackone.com/guides/defender.md)

**Where it runs:** server-side on every tool call (RPC/MCP/SDK/API) — "it protects any agent — MCP, the Agent SDK, or a direct API call." [tool-defense.md](https://docs.stackone.com/features/tool-defense.md)

**How (default "Both" detection mode, two-stage pipeline):** [defender.md](https://docs.stackone.com/guides/defender.md)
- **Tier 1 — pattern matching**: fast rule-based scan for known prompt-injection signatures; runs on every response with negligible latency.
- **Tier 2 — AI classification**: a local ML model (**MiniLM**) scores content for novel/subtle attacks; runs in parallel on every response. The model runs **locally** (no external API call, <100 ms typical added latency) and is **never trained on your data**.
- Detection modes: `Both` (default), `Pattern only`, `AI only`.

**Risk & blocking:** combined risk level from both tiers → low/medium allowed; **high + block enabled → blocked** (the tool call returns an error to the agent, which handles it like any other tool error); high + block disabled → allowed but **flagged in metadata**. `Block High Risk Content` defaults **off** (observe-first). Scan metadata (`riskLevel`, `tier2Score`, `detections`) is returned with every response "so you can observe what Defender is seeing, even when not blocking." [defender.md](https://docs.stackone.com/guides/defender.md)

**Advanced settings:** [defender.md](https://docs.stackone.com/guides/defender.md)

| Setting | Default |
|---|---|
| Detection Mode | Both |
| High Risk Threshold (score) | 0.8 |
| Medium Risk Threshold | 0.5 |
| Large Response Behavior (over size limits) | Skip scanning (alt: block / scan anyway) |
| Max Response Size | 1,048,576 bytes (1 MB) |
| Max Response Words | 10,000 |
| Annotate Tool Results (wrap sanitized results in `[UD-abc123]...[/UD-abc123]` boundary tags; pair with `generateBoundaryInstructions()` in the system prompt) | Off |
| Semantic Field Extractor (skip UUIDs/timestamps/URLs before classification) | On |

**Configuration hierarchy:** project-wide baseline in Project Settings → Defender; per-account and per-request overrides take precedence where supported; per-toolset SDK override in the TypeScript SDK (`@stackone/ai`): `useProjectSettings`, explicit config, or `null` to force-disable; the RPC response carries a `defenderMetadata` sibling. [defender.md](https://docs.stackone.com/guides/defender.md), [tool-defense.md](https://docs.stackone.com/features/tool-defense.md)

Note: docs are internally inconsistent on the default — the settings table says Status defaults **On (new projects)**, while the FAQ says Defender is **off by default**. Treat "off until enabled" as the operative default. [defender.md](https://docs.stackone.com/guides/defender.md)

---

## 6. Mapping to totem — adopt now vs defer

Baseline: totem v1 = multi-tenant MCP action layer, per-connection allowlists, audit_logs, `tt_live_` tenant API keys, Feishu OAuth per connection ([issue #1](https://github.com/0xnicholas/totem/issues/1)); connectors are pure translators ([ADR-0003](https://github.com/0xnicholas/totem/blob/main/docs/adr/0003-connectors-are-pure-translators.md)), MCP tools filtered by allowlist, hide-don't-reject ([ADR-0002](https://github.com/0xnicholas/totem/blob/main/docs/adr/0002-mcp-tools-filtered-by-allowlist.md)), TokenManager deep module ([ADR-0004](https://github.com/0xnicholas/totem/blob/main/docs/adr/0004-tokenmanager-deep-module.md)), 7-code error vocabulary ([ADR-0005](https://github.com/0xnicholas/totem/blob/main/docs/adr/0005-unified-error-vocabulary.md)).

### 6.1 Concept map

| StackOne | Totem | Notes |
|---|---|---|
| Linked Account | **Connection** | Same concept (one end-user's authorized instance of a system). Totem lacks a status enum and suspend. |
| Project | **Tenant** | Best fit: API-key scoping aligns (StackOne key = one project; totem `tt_live_` key = one tenant). Caveat in 6.4. |
| Connect session + `origin_owner_id` | OAuth authorize flow | Totem v1 has operator-configured Feishu creds; no self-serve linking. Connect-session pattern is the v2 self-serve model. |
| API key (scoped, scopes, last-used) | `tt_live_` key | Adopt scopes/disable/last-used now (6.3.2). |
| Connector profile (auth type, enabled actions, pinned version) | Connector + per-connection allowlist | Totem allowlist is finer-grained (per connection vs per profile). StackOne scoping = per-profile allowlist. |
| OAuth app management (shared vs own) | Per-tenant Feishu app credentials | Totem v1 already chose "own app" per tenant — correct for production; see 6.3.5. |
| Request logs + Advanced Logs | **audit_logs** | Closest analog. Totem's audit_logs is action-accountability ("who did what, when"), which StackOne only approximates via request logs. |
| Security logs (logins) | (none) | v1 has no dashboard logins; add when admin console lands (v2). |
| Webhooks (HMAC-signed) | (none) | Defer, but adopt the signature contract (6.3.4). |
| Defender | v2-deferred prompt-injection screening | Matches totem's out-of-scope list. Design is fully compatible with totem's execution boundary (6.5). |
| Roles / SSO / MFA | (none — CLI + admin key) | Defer to v2 admin console; see 6.3.6. |
| Connector versioning (semver pins) | (single connector) | Adopt the *convention* now; pinning infra v2 (6.3.7). |

### 6.2 What confirms totem's v1 design (no change)

- **Hide-don't-reject (ADR-0002)** matches StackOne's scoping model (enabled actions per profile) and its MCP behavior (tool catalog generated from the account's enabled actions). [mcp/auth-security.md](https://docs.stackone.com/mcp/auth-security.md), [scoping-connectors.md](https://docs.stackone.com/secure/scoping-connectors.md)
- **Connectors as pure translators (ADR-0003)** — StackOne separates connector (translation) from project/account/governance the same way.
- **Per-tenant encryption + token deep module (ADR-0004)** — StackOne stores credentials server-side and abstracts auth entirely; consistent with totem's TokenManager.
- **Tenant-scoped keys** — totem's "a tenant key can't reach another tenant's data" mirrors "a production key can't reach dev data" per project. [managing-projects.md](https://docs.stackone.com/guides/managing-projects.md)
- **Allowlist-at-execution-boundary** is stronger than StackOne's profile-level scoping (totem can vary per connection). Keep.

### 6.3 Adopt NOW (cheap, schema/CLI surface, v1)

1. **Connection status enum `active | suspended | auth_expired`** — StackOne has Active/Suspended/Error; totem only models `auth_expired` (a token state, [ADR-0004](https://github.com/0xnicholas/totem/blob/main/docs/adr/0004-tokenmanager-deep-module.md)). Add `suspended` (manual pause, credentials retained, no re-auth needed on resume) and make `auth_expired` a first-class status surfaced on the connection, not just an error code. This is one enum column + a CLI flag; it is the cheapest governance primitive StackOne has that totem lacks. [accounts-section.md](https://docs.stackone.com/guides/accounts-section.md)
2. **API key scopes + disable + last-used** — StackOne keys carry scopes (Actions Execute vs Platform API vs Credentials), can be disabled/deleted, and show `Last used` for stale-key review. Totem `tt_live_` keys are single-purpose; add (a) at least a scope bit separating "call actions" from "admin" usage, (b) disable/revoke, (c) `last_used_at` on the key row. All three are columns + CLI args in v1. [api-keys.md](https://docs.stackone.com/guides/api-keys.md)
3. **Audit row enrichment: `source`/channel, `success`, `duration_ms`** — StackOne request logs filter by Source (API/Dashboard/Webhook/Test) and record status, success, duration, and per-account. Totem's audit_logs already has status/error_code/param_hash ([issue #1](https://github.com/0xnicholas/totem/issues/1)); add `source` (mcp | admin_api | cli), `success bool`, `duration_ms`. Cheap columns, high forensic value. Optionally a per-tenant **opt-in request/response body capture** flag (StackOne gates detailed payload logging behind Advanced Logs, off by default, with error-only mode) — add the flag now, storage v2. [request-logs.md](https://docs.stackone.com/guides/request-logs.md), [observability.md](https://docs.stackone.com/secure/observability.md)
4. **MCP connection addressing: adopt an `x-connection-id`-style header** — spec user story 22 ([issue #1](https://github.com/0xnicholas/totem/issues/1)) says agents connect via MCP with a bearer key, but nothing defines how a request selects a connection; ADR-0002 already notes the server "must resolve the caller's tenant/connection before listing tools." StackOne solves this with `x-account-id` (or query-param fallback) on every MCP request — totem should do the same with `x-connection-id`. This is a transport-contract decision best made in v1. [mcp/auth-security.md](https://docs.stackone.com/mcp/auth-security.md)
5. **OAuth redirect URI discipline** — StackOne pins one redirect URI per provider (`https://api.stackone.com/connect/oauth2/{provider}/callback`) and registers it in the OAuth app config. Totem should register exactly one canonical redirect URI per deployment (e.g. `https://totem.example.com/oauth/callback/feishu`) in the per-tenant Feishu app, and record it in the connection config so re-auth never breaks. Also: totem's per-tenant Feishu app = StackOne's "your own OAuth app" pattern, which is the production-correct choice (branding, dedicated rate limits, verification) — keep, and document that shared-credential shortcuts are not an option for Feishu customer-facing use. [using-your-own-oauth-apps.md](https://docs.stackone.com/guides/using-your-own-oauth-apps.md)
6. **Admin actions are audit events too** — StackOne records login attempts at org level (security logs). Totem's `totemctl`/admin API ([issue #1](https://github.com/0xnicholas/totem/issues/1)) should write audit rows for administrative mutations (tenant created, key issued/revoked, allowlist changed, creds updated) with the admin identity + source. One code path change at the admin boundary; makes "who did what" complete.
7. **Connector versioning convention** — adopt StackOne's semver rule *as a documented contract* in v1 (major = auth changes/required scopes/removed actions → re-auth; minor = additive; patch = fixes) and the "pin production to `1.x.x`" habit, so when Feishu auth changes or totem ships custom connectors, the migration pattern (new profile pinned to new major → reconnect flow) is already known. Pinning infrastructure itself is v2. [connector-versioning.md](https://docs.stackone.com/guides/connector-versioning.md)
8. **Log-retention config field** — StackOne retains 90 days and lets projects configure retention + error-only. Totem v1 explicitly keeps all audit rows; keep that default but add the tenant-level `audit_retention_days` / `audit_error_only` config fields to the schema now so enforcement can be switched on without a migration later. [observability.md](https://docs.stackone.com/secure/observability.md)

### 6.4 Correct or decide NOW

- **Tenant vs project vs origin_owner conflation** — StackOne separates *operator isolation* (project: region, environment, API keys) from *customer isolation* (origin_owner_id inside a project). Totem's Tenant conflates both (CONTEXT.md: "the isolation unit of the platform" *and* "the paying entity"). Fine for v1 single-customer-per-tenant; but if totem becomes an embedded platform (tenants = totem's customers), the `origin_owner_id` field on connections and the project/owner split must be introduced later. Decide now whether `connections.owner_id` should exist in v1 to avoid a migration. StackOne's warning — set owner id server-side, never trust client input — is directly relevant to totem's v2 self-serve linking. [multi-tenant-accounts.md](https://docs.stackone.com/features/multi-tenant-accounts.md), [connect-session.md](https://docs.stackone.com/embed/connect-session.md)
- **API key prefix should encode environment/region** — StackOne's `v1.{region}.xxxxx` makes key provenance visible. Totem's `tt_live_` prefix hard-codes "live"; consider `tt_live_` / `tt_dev_` / region segment now (cosmetic but free). [managing-projects.md](https://docs.stackone.com/guides/managing-projects.md)
- **Bearer vs Basic** — StackOne authenticates API keys via HTTP Basic (key as username, empty password); totem uses Bearer. Both fine; keep Bearer but note the token-URL pattern StackOne uses for user-facing MCP clients (short-lived session token instead of the key) as the v2 answer to "give the agent a key without exposing tenant keys." [mcp/auth-security.md](https://docs.stackone.com/mcp/auth-security.md)

### 6.5 Defer to v2 (with the contract pre-recorded)

- **Defender ↔ v2-deferred prompt-injection screening**: totem's spec already defers this ([issue #1](https://github.com/0xnicholas/totem/issues/1)). The mapping is clean: Defender would live at totem's execution boundary (`executeAction` response path, before the MCP server returns tool results — "before they reach your LLM"). Record these decisions now so v2 implements without re-research: two-stage (cheap pattern scan always + local ML optional), **observe-first** default (flag in metadata, don't block), risk metadata on the response (`riskLevel`, `tier2Score`, `detections`), boundary annotations for the agent, and per-tenant overrides. Feishu Docs is exactly the "third-party documents containing instructions" vector Defender targets, so this is a priority v2 item, not an optional one. [defender.md](https://docs.stackone.com/guides/defender.md), [tool-defense.md](https://docs.stackone.com/features/tool-defense.md)
- **Webhooks**: v1 has none; when added (v2), adopt StackOne's contract verbatim: HMAC-SHA256 over the **raw body** in `x-stackone-signature`, constant-time compare, dual-secret rotation, 200-fast response, account lifecycle events (`account.created`/`updated`/`deleted`), and the "event enabled on profile AND routed to webhook" rule. Totem will need `connection.created` as its first event (the async completion signal for user OAuth, StackOne's Auth-Link equivalent). [webhooks.md](https://docs.stackone.com/guides/webhooks.md), [handle-account-events.md](https://docs.stackone.com/embed/handle-account-events.md)
- **Roles / SSO / MFA**: all dashboard-console concerns; totem v1 has no end-user accounts and no console. Defer wholesale, but the *model* to copy is StackOne's: 2 org roles + 3 project roles, independent axes, per-account sharing for "member linked their own accounts" (which is exactly how totem should let a tenant delegate connections to multiple Feishu users in v2), org-enforced TOTP MFA, SAML 2.0 + DNS domain verification. [managing-your-organization.md](https://docs.stackone.com/guides/managing-your-organization.md), [sso-setup.md](https://docs.stackone.com/guides/sso-setup.md)
- **Underlying-provider request logging**: StackOne logs both the unified request and the provider calls behind it. Totem's Seam B (connector HTTP boundary) is the natural instrumentation point; defer, but keep `duration_ms`/`success` on audit rows now so the v2 join works. [request-logs.md](https://docs.stackone.com/guides/request-logs.md)
- **Log export/observability sync**: totem's audit_logs is a Postgres table; exporting to Grafana/Datadog/OTel ([observability-sync.md](https://docs.stackone.com/api/observability-sync.md)) is a v2 convenience — no schema impact if the audit columns above land in v1.

### 6.6 Severity summary

- **High-value, low-cost, adopt in v1:** connection status enum incl. `suspended`; API-key disable/last-used (+ minimal scopes); audit `source`/`success`/`duration_ms`; `x-connection-id` MCP addressing; admin actions audited.
- **Schema insurance, adopt in v1:** audit retention/error-only config fields; `connections.owner_id` decision; key prefix env/region segment.
- **Contract-only now, implement v2:** Defender design (observe-first, two-tier, boundary tags); webhook signing contract; versioning convention; roles/SSO/MFA model.

---

## Sources

- Kept (all cited inline above): `docs.stackone.com/llms.txt` (index), `guides/embedding-stackone-hub.md`, `guides/auth-link.md`, `guides/accounts-section.md`, `guides/api-keys.md`, `guides/managing-projects.md`, `guides/project-settings.md`, `guides/using-your-own-oauth-apps.md`, `guides/defender.md`, `guides/request-logs.md` (canonical: `/connect/troubleshooting`), `guides/webhooks.md`, `guides/managing-your-organization.md` (canonical: `/secure/team-management`), `guides/sso-setup.md`, `guides/connector-versioning.md`, `guides/connector-profiles.md`, `guides/ai-features.md`, `embed/connect-session.md`, `embed/handle-account-events.md`, `features/multi-tenant-accounts.md`, `features/tool-defense.md`, `connect/managing-connectors/linking-accounts.md`, `secure/scoping-connectors.md`, `secure/observability.md`, `api/observability-sync.md`, `mcp/auth-security.md` — all primary vendor documentation.
- Totem side: GitHub [issue #1 (spec)](https://github.com/0xnicholas/totem/issues/1), [issue #14](https://github.com/0xnicholas/totem/issues/14), ADRs [0001](https://github.com/0xnicholas/totem/blob/main/docs/adr/0001-platform-defined-actions.md)–[0005](https://github.com/0xnicholas/totem/blob/main/docs/adr/0005-unified-error-vocabulary.md), [CONTEXT.md](https://github.com/0xnicholas/totem/blob/main/CONTEXT.md).
- Dropped: no third-party commentary used; secondary SEO sources excluded.

## Gaps

- StackOne docs are internally inconsistent on whether Defender is on or off by default for new projects (settings table says On; FAQ says off) — flagged; assume off-until-enabled.
- No dedicated "audit log" guide exists in StackOne docs (index has no match for "audit"); the audit story was reconstructed from request logs + security logs + observability pages.
- "Connector profiles" default-profile/Hub behavior and IP-restriction setting (Project Settings) were noted but not exhaustively covered.
- Cannot verify which StackOne behavior totem's Feishu connector will need in practice (e.g., whether Feishu allows multiple redirect URIs); verify against the Feishu Open Platform app console when implementing 6.3.5.
- Next step: run the git/gh workflow (branch, commit, push, issue comment/close) — not executable from this subagent (no shell tool); commands provided in the acceptance report.
