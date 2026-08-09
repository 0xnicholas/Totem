-- 002_feishu_credentials.up.sql
-- Per-tenant Feishu app credentials (own-app model per StackOne research:
-- "Per-tenant Feishu app credentials — totem v1 already chose 'own app' per
-- tenant"). One row per tenant; used by the OAuth flow (T6).

CREATE TABLE feishu_credentials (
    tenant_id  UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
    app_id     TEXT NOT NULL,
    -- TODO(ADR-0004): encrypt app_secret at rest with the per-tenant key
    -- when the TokenManager lands (T6); column stores ciphertext then.
    app_secret TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
