-- 008_wecom_credentials.up.sql
-- Per-tenant WeCom self-built app credentials (ADR-0017, mirroring
-- 002_feishu_credentials / 006_dingtalk_credentials). One row per tenant.
-- WeCom connections are CREDENTIAL connections: registering these
-- credentials creates the wecom_messaging connection (no OAuth dance) —
-- corp_id + agent_id are plain identifiers, secret is ciphertext at rest
-- (ADR-0004, per-tenant key), written encrypted by the admin API.

CREATE TABLE wecom_credentials (
    tenant_id  UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
    corp_id    TEXT NOT NULL,
    agent_id   TEXT NOT NULL,
    secret     TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
