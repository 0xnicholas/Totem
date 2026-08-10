ALTER TABLE audit_logs DROP COLUMN metadata;

ALTER TABLE tenants
  DROP COLUMN defender_block_high_risk,
  DROP COLUMN defender_enabled;
