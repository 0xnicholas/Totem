# Totem

A self-hosted, multi-tenant service that exposes a curated, schema-first set of
actions over MCP, backed by pluggable connectors to real systems (v1 targets
Feishu Docs). See [issue #1](https://github.com/0xnicholas/totem/issues/1) for
the full spec.

## Status

v1 in progress, built ticket-by-ticket (see GitHub Issues). Current state
(T1): project skeleton plus the schema-first action registry and the
`executeAction` execution boundary (Seam A), exercised through an in-memory
fake connector that implements the same `IConnector` adapter contract as real
connectors.

## Consuming projects

Other internal projects integrate with totem as tenants over two surfaces —
MCP for agents, REST Actions RPC for non-agent code. See
[docs/integration-guide.md](docs/integration-guide.md): onboarding, auth
headers, error handling, and the smoke test.

## Development

```sh
npm install
npm run lint      # ESLint (flat config, typescript-eslint)
npm run typecheck # tsc --noEmit
npm test          # Vitest
```

The migration tests run only when `DATABASE_URL` is set (the CI postgres
service, or locally: `docker compose up db` then
`DATABASE_URL=postgres://totem:totem@localhost:5433/totem npm test`).

## Database

```sh
cp .env.example .env   # optional; compose defaults work out of the box
npm run migrate:up     # apply pending migrations (requires DATABASE_URL)
npm run migrate:down   # roll back the most recently applied migration
```

Migrations live in `migrations/<version>_<name>.up.sql` / `.down.sql` and
are applied by `scripts/migrate.mjs`, which tracks applied versions in a
`schema_migrations` table (re-runnable by design; each migration runs in its
own transaction). `docker compose up` starts Postgres, applies
migrations once via the one-shot `migrate` service (the API waits for it,
so replicas never race on startup), and serves the admin API on
`http://localhost:3000`.

## Admin surface (totemctl + admin API)

The admin API (T3) is the operator surface: tenants, tenant API keys,
Feishu app credentials, per-connection allowlists, connection
suspend/resume, and the audit trail. Every /admin route requires the
platform admin key (`TOTEM_ADMIN_KEY`, separate from tenant keys); every
mutation writes an audit row (`source: admin_api`).

```sh
npm run dev          # admin API server (requires DATABASE_URL + TOTEM_ADMIN_KEY)

export TOTEM_ADMIN_URL=http://localhost:3000
# TOTEM_ADMIN_KEY is required by every totemctl command
npm run totemctl -- create-tenant acme
npm run totemctl -- create-key <tenant-id> --scope admin   # prints the key once
npm run totemctl -- set-feishu-creds <tenant-id> <app-id> <app-secret>
npm run totemctl -- set-dingtalk-creds <tenant-id> <app-key> <app-secret>
npm run totemctl -- set-allowlist <connection-id> create_doc read_doc
npm run totemctl -- suspend-connection <connection-id>
npm run totemctl -- query-audit <tenant-id> --action admin.tenant_created
npm run totemctl -- get-audit-policy <tenant-id>
npm run totemctl -- set-audit-policy <tenant-id> --retention-days 30 --error-only true
npm run totemctl -- purge-audit <tenant-id>          # delete rows past retention
```

Admin API routes: `POST /admin/tenants`, `POST /admin/tenants/:id/keys`,
`POST /admin/tenants/:id/keys/:keyId/disable`, `POST
/admin/tenants/:id/feishu-creds`, `POST
/admin/tenants/:id/dingtalk-creds`, `PUT /admin/connections/:id/allowlist`,
`POST /admin/connections/:id/suspend|resume`, `GET
/admin/tenants/:id/audit` (filters: `user`, `action`, `since`, `source`,
`success`), `GET|PUT /admin/tenants/:id/audit-policy` (retention days,
error-only, body-capture flag), `POST /admin/tenants/:id/audit/purge`,
`GET /healthz`.

## Governance (T4)

`executeAction` enforces governance at the execution boundary (Seam A):

- **Allowlist (fail-closed)** — an action not on the connection's allowlist
  is rejected with a structured `forbidden` error before validation or
  dispatch. An empty allowlist allows nothing. Allowlist rows are set via
  `totemctl set-allowlist` and read per (tenant, connection).
- **Audit** — every attempt on a resolvable connection writes an
  `audit_logs` row (tenant, connection, action, SHA-256 param hash, source,
  success, ADR-0005 error code, duration). Writes are best effort: an audit
  outage is logged, never fatal to the action. Rows are queryable with
  `totemctl query-audit`. Attempts with an unknown tenant/connection are
  unattributable under the schema's `audit_logs.tenant_id` foreign key and
  are not recorded.

CI (GitHub Actions) runs lint, typecheck and the full test suite —
migrations and admin integration tests included — against a Postgres
service container.

Per-tenant audit policy (T11): `audit_retention_days` (default 90) and
`audit_error_only` govern the audit trail — error-only tenants record only
failures (the trail answers "what failed, when" at lower volume), and
`totemctl purge-audit` deletes rows past the retention window. The
`capture_body` flag is settable now; request/response body capture is v2.

## REST discovery (T12)

The registry is discoverable programmatically without an agent: `GET
/actions` (the platform action set as name/description/effects metadata)
and `POST /actions/search` (case-insensitive text search across names and
descriptions; semantic search is v2). Both authenticate with a tenant
actions-scope API key (Bearer) — no connection needed — and never expose
hidden actions. This is the read-only first step of the v2 REST surface;
the RPC envelope (`POST /actions/rpc`) lands when the MCP adapter proves
it.

## Rate limiting (T13)

A token bucket at the execution boundary (`executeAction`, Seam A) limits
each (tenant, connection) to its per-minute budget: the connector's manifest
`rateLimit` (requests per minute per connected account), falling back to a
platform default of 600/min. A denied call returns the `rate_limited`
vocabulary error with `retryAfterSeconds` — the agent's retry signal
(ADR-0005 `retryable`) — and is audited like any other failure. The gate
sits after the allowlist (a forbidden call never burns the bucket) and
before validation/dispatch. No queueing, no platform-side auto-retry; the
HTTP 429 + `Retry-After` mapping lands with the REST RPC surface (T14).

## Defender tripwire (T15)

Tool responses are scanned for prompt-injection directives at the execution
boundary's return path (ADR-0009, Tier 1 slice): the curated signature set
in `src/defender.ts` runs over the unified output before it reaches the
agent, and the metadata (`{tier: 'pattern', riskLevel, detections}`) rides
the action result and the audit row — the observation path is
`totemctl query-audit`, no dashboard needed. Responses over 1MB are
skipped without a claim. Observe-first: scanning is on by default,
blocking is opt-in per tenant (`set-defender-policy --block-high-risk
true`); when blocking, high-risk content becomes a `forbidden` error with
`details.reason = defender_block` (vocabulary stays at seven codes). The
ML tier is T16; `tier: 'pattern'` keeps the two distinguishable.

## Layout

- `src/action.ts` — the platform `Action` shape (`name`, `description`,
  `inputSchema`, `outputSchema`), `ActionHandler`, `ActionContext`
- `src/actions.ts` — v1 platform action definitions for the Docs domain
  (ADR-0001: the platform owns actions; connectors implement them)
- `src/connector.ts` — the `IConnector` adapter contract (ADR-0003:
  pure translator with a `manifest` + `execute`)
- `src/registry.ts` — schema-first action registry (Ajv-compiled schemas)
- `src/executor.ts` — `executeAction` (Seam A) and the composition root
- `src/governance.ts` — allowlist store + audit sink contracts (T4)
- `src/pg-governance.ts` — Postgres implementations of both
- `src/audit.ts` — canonical param hashing for audit rows
- `src/admin/` — admin API (hono), Postgres repository, HTTP client, keys
- `src/rest/` — REST surface: discovery (T12) + Actions RPC (T14)
- `src/cli/` — `totemctl` commands
- `src/server/` — service entry point (env wiring)
- `src/errors.ts` — the unified error vocabulary (ADR-0005: seven codes)
- `src/rate-limit.ts` — per-(tenant, connection) token bucket (T13)
- `src/defender.ts` — prompt-injection signature scan + metadata (T15)
- `src/testing/` — Seam A and HTTP-boundary test doubles
  (`FakeConnector`, `InMemoryAdminRepository`)
- `test/` — behavior tests through Seam A / HTTP boundary only
