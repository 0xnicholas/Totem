-- Reverse of 003: restore the plaintext-era column documentation.

COMMENT ON COLUMN feishu_credentials.app_secret IS 'TODO(ADR-0004): encrypt app_secret at rest with the per-tenant key when the TokenManager lands (T6); column stores ciphertext then.';
