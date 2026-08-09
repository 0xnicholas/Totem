-- 001_initial_schema.down.sql
-- Reverse of the up migration: drop children first, then parents, then the
-- enum types they depend on.

DROP TABLE IF EXISTS tokens;
DROP TABLE IF EXISTS audit_logs;
DROP TABLE IF EXISTS allowlists;
DROP TABLE IF EXISTS api_keys;
DROP TABLE IF EXISTS connections;
DROP TABLE IF EXISTS tenants;

DROP TYPE IF EXISTS audit_source;
DROP TYPE IF EXISTS api_key_scope;
DROP TYPE IF EXISTS connection_status;
