-- PG has no DROP VALUE; recreate the enum without 'rpc' and re-cast the
-- column. Any rows already tagged 'rpc' would fail the cast — roll back
-- only makes sense before such rows exist.
ALTER TYPE audit_source RENAME TO audit_source_old;
CREATE TYPE audit_source AS ENUM ('mcp', 'admin_api', 'cli');
ALTER TABLE audit_logs
  ALTER COLUMN source TYPE audit_source USING source::text::audit_source;
DROP TYPE audit_source_old;
