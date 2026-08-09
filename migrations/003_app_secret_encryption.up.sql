-- 003_app_secret_encryption.up.sql
-- Issue #15: feishu_credentials.app_secret now stores AES-256-GCM
-- ciphertext in the v1:<iv>:<ciphertext> format, encrypted with the
-- per-tenant key derived from TOTEM_TOKEN_ENC_KEY (ADR-0004). The app
-- layer encrypts on write (admin API) and decrypts on read (creds store);
-- legacy plaintext rows are detected by the missing v1: prefix and
-- re-encrypted lazily on read. v1 has no production rows, so no eager
-- data migration is needed.

COMMENT ON COLUMN feishu_credentials.app_secret IS 'AES-256-GCM ciphertext (v1:<iv>:<ct>, per-tenant key derived from TOTEM_TOKEN_ENC_KEY, ADR-0004, issue #15). Legacy plaintext rows are re-encrypted lazily on read.';
