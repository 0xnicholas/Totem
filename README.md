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
own transaction). `docker compose up` starts Postgres and applies
migrations on the API container's startup.

CI (GitHub Actions) runs lint, typecheck and the full test suite —
migrations tests included — against a Postgres service container.

## Layout

- `src/action.ts` — the platform `Action` shape (`name`, `description`,
  `inputSchema`, `outputSchema`), `ActionHandler`, `ActionContext`
- `src/actions.ts` — v1 platform action definitions for the Docs domain
  (ADR-0001: the platform owns actions; connectors implement them)
- `src/connector.ts` — the `IConnector` adapter contract (ADR-0003:
  pure translator with a `manifest` + `execute`)
- `src/registry.ts` — schema-first action registry (Ajv-compiled schemas)
- `src/executor.ts` — `executeAction` (Seam A) and the composition root
- `src/errors.ts` — the unified error vocabulary (ADR-0005: seven codes)
- `src/testing/fake-connector.ts` — in-memory connector used as the test
  double at Seam A
- `test/` — behavior tests through Seam A only
