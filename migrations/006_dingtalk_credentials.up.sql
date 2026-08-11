-- 006_dingtalk_credentials.up.sql
-- Per-tenant DingTalk app credentials (own-app model per StackOne research,
-- mirroring 002_feishu_credentials). One row per tenant; used by the
-- DingTalk OAuth flow (T17a). app_secret is ciphertext at rest (ADR-0004,
-- per-tenant key), written encrypted by the admin API.

CREATE TABLE dingtalk_credentials (
    tenant_id  UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
    app_key    TEXT NOT NULL,
    app_secret TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
