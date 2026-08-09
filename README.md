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
own transaction). `docker compose up` starts Postgres, applies migrations
on the API container's startup, and serves the admin API on
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
npm run totemctl -- set-allowlist <connection-id> create_doc read_doc
npm run totemctl -- suspend-connection <connection-id>
npm run totemctl -- query-audit <tenant-id> --action admin.tenant_created
```

Admin API routes: `POST /admin/tenants`, `POST /admin/tenants/:id/keys`,
`POST /admin/tenants/:id/keys/:keyId/disable`, `POST
/admin/tenants/:id/feishu-creds`, `PUT /admin/connections/:id/allowlist`,
`POST /admin/connections/:id/suspend|resume`, `GET
/admin/tenants/:id/audit` (filters: `user`, `action`, `since`, `source`,
`success`), `GET /healthz`.

CI (GitHub Actions) runs lint, typecheck and the full test suite —
migrations and admin integration tests included — against a Postgres
service container.

## Layout

- `src/action.ts` — the platform `Action` shape (`name`, `description`,
  `inputSchema`, `outputSchema`), `ActionHandler`, `ActionContext`
- `src/actions.ts` — v1 platform action definitions for the Docs domain
  (ADR-0001: the platform owns actions; connectors implement them)
- `src/connector.ts` — the `IConnector` adapter contract (ADR-0003:
  pure translator with a `manifest` + `execute`)
- `src/registry.ts` — schema-first action registry (Ajv-compiled schemas)
- `src/executor.ts` — `executeAction` (Seam A) and the composition root
- `src/admin/` — admin API (hono), Postgres repository, HTTP client, keys
- `src/cli/` — `totemctl` commands
- `src/server/` — service entry point (env wiring)
- `src/errors.ts` — the unified error vocabulary (ADR-0005: seven codes)
- `src/testing/` — Seam A and HTTP-boundary test doubles
  (`FakeConnector`, `InMemoryAdminRepository`)
- `test/` — behavior tests through Seam A / HTTP boundary only
