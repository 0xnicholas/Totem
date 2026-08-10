-- Defender tripwire (T15, ADR-0009): per-tenant response-screening policy,
-- observe-first defaults (scanning on, blocking off), plus the audit
-- metadata column that carries scan results to the observation path
-- (totemctl query-audit).
ALTER TABLE tenants
  ADD COLUMN defender_enabled BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN defender_block_high_risk BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE audit_logs ADD COLUMN metadata JSONB;
