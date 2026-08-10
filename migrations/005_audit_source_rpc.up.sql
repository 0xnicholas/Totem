-- REST Actions RPC executions are audited with source 'rpc' (the
-- AuditSource union grew when the RPC surface landed, ADR-0008); the
-- column's enum must follow. Safe inside a transaction on PG 12+ as long
-- as the new value is not used in the same migration.
ALTER TYPE audit_source ADD VALUE IF NOT EXISTS 'rpc';
