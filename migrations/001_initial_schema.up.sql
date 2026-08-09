-- 001_initial_schema.up.sql
-- v1 data layer (T2). Domain vocabulary per CONTEXT.md: tenant, connection,
-- allowlist, audit log, opaque id. Fields follow the StackOne research
-- amendments (connection status/owner_id, api key scope/prefixes, audit
-- source/success/duration, tenant audit config, OAuth redirect URI).

-- Tenants: the isolation unit of the platform. Owns connections, API keys,
-- allowlists and audit rows.
CREATE TABLE tenants (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name                 TEXT NOT NULL,
    -- Audit config; enforcement lands in v2 (schema now, per research
    -- amendments). capture_body is an opt-in flag; body storage is v2.
    audit_retention_days INTEGER NOT NULL DEFAULT 90,
    audit_error_only     BOOLEAN NOT NULL DEFAULT false,
    capture_body         BOOLEAN NOT NULL DEFAULT false,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TYPE connection_status AS ENUM ('active', 'suspended', 'auth_expired');

-- Connections: one tenant's authorized instance of a system. Data, not
-- code; a connector serves many connections.
CREATE TABLE connections (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id          UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    -- Matches a connector manifest id (e.g. 'feishu_docs'), ADR-0003.
    connector_id       TEXT NOT NULL,
    name               TEXT NOT NULL,
    status             connection_status NOT NULL DEFAULT 'active',
    -- Server-set; v1 equals the tenant id (research amendment).
    owner_id           TEXT NOT NULL,
    -- Canonical OAuth redirect URI for this deployment (research amendment).
    oauth_redirect_uri TEXT,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX connections_tenant_id_idx ON connections (tenant_id);

CREATE TYPE api_key_scope AS ENUM ('actions', 'admin');

-- Tenant-level API keys: tt_live_/tt_dev_ prefix, SHA-256 hashed at rest.
CREATE TABLE api_keys (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    prefix       TEXT NOT NULL CHECK (prefix IN ('tt_live_', 'tt_dev_')),
    key_hash     TEXT NOT NULL UNIQUE,
    scope        api_key_scope NOT NULL DEFAULT 'actions',
    disabled_at  TIMESTAMPTZ,
    last_used_at TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX api_keys_tenant_id_idx ON api_keys (tenant_id);

-- Per-connection action allowlists, keyed by unified action name (ADR-0001).
CREATE TABLE allowlists (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    connection_id UUID NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
    action_name   TEXT NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (connection_id, action_name)
);

CREATE INDEX allowlists_tenant_id_idx ON allowlists (tenant_id);

CREATE TYPE audit_source AS ENUM ('mcp', 'admin_api', 'cli');

-- Append-only record of every execution attempt: "who did what, when".
-- connection_id is nullable with ON DELETE SET NULL so audit history
-- survives connection deletion (v1 keeps all rows).
CREATE TABLE audit_logs (
    id            BIGSERIAL PRIMARY KEY,
    tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    connection_id UUID REFERENCES connections(id) ON DELETE SET NULL,
    -- Acting user where available; v1 rows carry the connection's owner_id.
    user_id       TEXT,
    action_name   TEXT NOT NULL,
    -- SHA-256 hex of canonicalized params.
    param_hash    TEXT NOT NULL,
    source        audit_source NOT NULL,
    success       BOOLEAN NOT NULL,
    -- ADR-0005 error code when the execution failed.
    error_code    TEXT,
    duration_ms   INTEGER NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX audit_logs_tenant_created_idx ON audit_logs (tenant_id, created_at DESC);
CREATE INDEX audit_logs_tenant_action_idx ON audit_logs (tenant_id, action_name);

-- Encrypted Feishu user/refresh tokens, one row per connection (ADR-0004).
CREATE TABLE tokens (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id         UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    connection_id     UUID NOT NULL UNIQUE REFERENCES connections(id) ON DELETE CASCADE,
    -- Ciphertext at rest (per-tenant encryption key, ADR-0004).
    user_access_token TEXT NOT NULL,
    refresh_token     TEXT NOT NULL,
    expires_at        TIMESTAMPTZ NOT NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX tokens_tenant_id_idx ON tokens (tenant_id);
