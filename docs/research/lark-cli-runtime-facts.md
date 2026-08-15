# Research: lark-cli runtime facts — headless auth, token injection, invocation contract, error envelope

**Scope:** Whether `@larksuite/cli` (lark-cli) can run server-side/headless with externally supplied credentials, and what its process invocation, output/error envelope, and supply-chain surface look like — the facts ticket #52 collects for the execution-engine adjudication. Primary source: the source tree of `larksuite/cli` at commit [`525a982`](https://github.com/larksuite/cli/tree/525a98270f80693bdaf3c0a6006e9f3f94820851) (cloned 2026-08), plus the [npm package](https://www.npmjs.com/package/@larksuite/cli) and [README.md](https://github.com/larksuite/cli/blob/525a98270f80693bdaf3c0a6006e9f3f94820851/README.md). Totem comparison baseline: ADRs [0003](https://github.com/0xnicholas/totem/blob/main/docs/adr/0003-connectors-are-pure-translators.md), [0015](https://github.com/0xnicholas/totem/blob/main/docs/adr/0015-oauth-lifecycle-platform-module.md), [0005](https://github.com/0xnicholas/totem/blob/main/docs/adr/0005-unified-error-vocabulary.md), [0009](https://github.com/0xnicholas/totem/blob/main/docs/adr/0009-defender-response-screening.md).

---

## 1. What ships: Go binary + thin npm wrapper

- The CLI is a **Go program** ([`go.mod`](https://github.com/larksuite/cli/blob/525a98270f80693bdaf3c0a6006e9f3f94820851/go.mod), module `github.com/larksuite/cli`, go 1.23); the npm package `@larksuite/cli` (v1.0.87) is a **wrapper**: its `bin` points at [`scripts/run.js`](https://github.com/larksuite/cli/blob/525a98270f80693bdaf3c0a6006e9f3f94820851/scripts/run.js), a Node script that `execFileSync`s a platform Go binary installed by the `postinstall` hook.
- The postinstall ([`scripts/install.js`](https://github.com/larksuite/cli/blob/525a98270f80693bdaf3c0a6006e9f3f94820851/scripts/install.js)) downloads the binary from GitHub releases (mirror: npmmirror), gated by a host allowlist and verified by **checksums** — "checksum verification is the primary integrity control".
- **Server consequence:** the Go binary is distributed standalone via releases, so a server deployment can skip npm/Node entirely and invoke the binary directly. The npm wrapper requires Node >= 16 ([package.json](https://github.com/larksuite/cli/blob/525a98270f80693bdaf3c0a6006e9f3f94820851/package.json)).
- License: MIT ([LICENSE](https://github.com/larksuite/cli/blob/525a98270f80693bdaf3c0a6006e9f3f94820851/LICENSE), 2026 Lark Technologies Pte. Ltd.). Platforms: darwin/linux/win32, x64/arm64/riscv64.

## 2. Authentication — headless-capable, four modes

| Mode | Mechanism | Evidence |
|---|---|---|
| Interactive device flow | `auth login` TUI or flags (`--domain`, `--recommend`, `--scope`); OAuth 2.0 device code | [README Authentication](https://github.com/larksuite/cli/blob/525a98270f80693bdaf3c0a6006e9f3f94820851/README.md), [`cmd/auth/login.go`](https://github.com/larksuite/cli/blob/525a98270f80693bdaf3c0a6006e9f3f94820851/cmd/auth/login.go) |
| Agent-mode login | `--no-wait` returns device code + verification URL immediately, non-blocking; resume later with `--device-code` | README Authentication |
| **Direct token injection** | Env vars `LARKSUITE_CLI_USER_ACCESS_TOKEN` and `LARKSUITE_CLI_TENANT_ACCESS_TOKEN` supply ready tokens — **no OAuth dance, no keychain**; app credentials via `LARKSUITE_CLI_APP_ID` / `LARKSUITE_CLI_APP_SECRET` | [`internal/envvars/envvars.go`](https://github.com/larksuite/cli/blob/525a98270f80693bdaf3c0a6006e9f3f94820851/internal/envvars/envvars.go) |
| **Auth sidecar protocol** | CLI (sandbox) → plain HTTP → trusted sidecar that holds credentials; requests HMAC-SHA256-signed over version+target+identity+timestamp+body-sha256; sidecar injects the real token into `Authorization` (or `X-Lark-MCP-UAT`/`X-Lark-MCP-TAT` for MCP surfaces). Reference servers include a **multi-tenant demo** with allowlist + audit | [`sidecar/protocol.go`](https://github.com/larksuite/cli/blob/525a98270f80693bdaf3c0a6006e9f3f94820851/sidecar/protocol.go), [`sidecar/server-multi-tenant-demo/`](https://github.com/larksuite/cli/tree/525a98270f80693bdaf3c0a6006e9f3f94820851/sidecar/server-multi-tenant-demo) |

- Identity switching per command: `--as user | --as bot`; default via `LARKSUITE_CLI_DEFAULT_AS`; multiple authenticated users via `auth list`; profiles via `LARKSUITE_CLI_PROFILE`. Credential storage: OS keychain on desktop ([`internal/keychain/keychain_darwin.go`](https://github.com/larksuite/cli/blob/525a98270f80693bdaf3c0a6006e9f3f94820851/internal/keychain/keychain_darwin.go), `keychain_windows.go`) or config-dir files in workspaces ([`internal/core/workspace.go`](https://github.com/larksuite/cli/blob/525a98270f80693bdaf3c0a6006e9f3f94820851/internal/core/workspace.go)); secrets in config accept `SecretRef` unions — plain string or external ref `{source: file|keychain, id: env-var/file-path/command/keychain-key}` ([`internal/core/secret.go`](https://github.com/larksuite/cli/blob/525a98270f80693bdaf3c0a6006e9f3f94820851/internal/core/secret.go)).
- **Takeaway for #54:** the two constraints an engine adoption would have feared — keychain-only auth and interactive-only login — do not hold. Token injection from env and the HMAC sidecar protocol are first-class, server-shaped designs.

## 3. Invocation & output contract

- Success → **stdout**, exit 0: `{"ok": true, "identity": "user"|"bot", "data": {...}, "meta": {...}}`. Errors → **stderr**, non-zero exit: `{"ok": false, "identity": ..., "error": {"type", "subtype", "code", "message", "hint", "log_id", ...}}` — consumers test `ok == true` (or exit code), **not** `code == 0`; `code` carries the upstream OpenAPI code only inside `error` (README "JSON Output Contract").
- Output formats: `--format json` (default) | `pretty` | `table` | `ndjson` | `csv`.
- Exit codes derive from the error **Category** ([`errs/ERROR_CONTRACT.md`](https://github.com/larksuite/cli/blob/525a98270f80693bdaf3c0a6006e9f3f94820851/errs/ERROR_CONTRACT.md)): 9 closed categories, wire-stable `type`+`subtype` identifiers, RFC 7807-aligned; predicate commands use a deliberate silent-exit that bypasses the envelope.
- The contract doc names three audiences: agents/shell scripts parsing stderr, **protocol adapters mapping CLI errors into MCP/OAuth shapes**, and framework code — i.e. embedding the CLI under an MCP layer is an anticipated use, and `error.hint` carries agent-directed remediation instructions.
- Raw layer: `lark-cli api <method> <path>` passes through upstream errors **untouched** — `errs.MarkRaw` forbids the dispatcher from rewriting message/hint ([`errs/raw.go`](https://github.com/larksuite/cli/blob/525a98270f80693bdaf3c0a6006e9f3f94820851/errs/raw.go)); the typed taxonomy wraps them otherwise (upstream numeric code preserved in `error.code`).
- Pagination: global `--page-all`, `--page-limit`, `--page-delay`; the transport parses Feishu gateway pacing headers `X-Ogw-Ratelimit-Limit/Reset` plus standard `Retry-After` ([`internal/ratelimit/headers.go`](https://github.com/larksuite/cli/blob/525a98270f80693bdaf3c0a6006e9f3f94820851/internal/ratelimit/headers.go)).

## 4. Its own governance layers (overlap with totem invariants)

- Per-command risk annotations (`read` / `write` / `high-risk-write`) enforced by a YAML **command policy engine** — max-risk rules, denial, diagnostics ([`internal/cmdpolicy/engine.go`](https://github.com/larksuite/cli/blob/525a98270f80693bdaf3c0a6006e9f3f94820851/internal/cmdpolicy/engine.go), [`apply.go`](https://github.com/larksuite/cli/blob/525a98270f80693bdaf3c0a6006e9f3f94820851/internal/cmdpolicy/apply.go)).
- `--dry-run` preview for side-effect commands; `LARKSUITE_CLI_CONTENT_SAFETY_MODE` content-safety switch; agent attribution envs `LARKSUITE_CLI_AGENT_NAME` / `LARKSUITE_CLI_AGENT_TRACE` ([`internal/envvars/envvars.go`](https://github.com/larksuite/cli/blob/525a98270f80693bdaf3c0a6006e9f3f94820851/internal/envvars/envvars.go)); README carries a "Security & Risk Warnings" section.

## 5. Supply chain & machine-readable API surface

- Go dependencies: notably the **official** `github.com/larksuite/oapi-sdk-go/v3` (v3.7.2); TUI libs (charmbracelet huh/lipgloss), spf13/cobra, gojq, go-diff, etc. ([`go.mod`](https://github.com/larksuite/cli/blob/525a98270f80693bdaf3c0a6006e9f3f94820851/go.mod)). npm side: single dependency `@clack/prompts`; binary fetched at postinstall, checksum-verified.
- The command catalog is **generated and introspectable**: `lark-cli schema [<method>]` exposes any method's params, request/response structure, supported identities, and scopes ([`cmd/schema/`](https://github.com/larksuite/cli/blob/525a98270f80693bdaf3c0a6006e9f3f94820851/cmd/schema/schema.go), [`internal/apicatalog/`](https://github.com/larksuite/cli/tree/525a98270f80693bdaf3c0a6006e9f3f94820851/internal/apicatalog)). This resolves the map's fog question "is the endpoint-definition corpus machine-readable?": **yes** — a generated catalog with a schema-introspection command and typed method refs exists.

## 6. Answer gist (ticket #52)

Yes, lark-cli is headless-capable: direct token injection via env vars (user or tenant access tokens), app credentials via env, and a purpose-built HMAC-signed auth-sidecar protocol with a reference multi-tenant server (allowlist + audit). Errors are a typed, wire-stable envelope on stderr with agent-directed hints, exit codes derived from a closed category set, and raw passthrough that preserves upstream codes. Runtime is a standalone Go binary (npm/Node optional at runtime), MIT-licensed, built on the official Go SDK, with checksum-verified distribution. The constraints an engine adoption would have feared — keychain-only auth, interactive-only login, opaque errors — do not hold; the adjudication (#54) therefore turns on other grounds: process-per-call architecture, envelope translation into totem's unified vocabulary, governance duplication (cmdpolicy vs allowlist), and DingTalk asymmetry.

---

## Erratum (2026-08-15): §5 corpus claim — measured and superseded

§5's takeaway ("the command catalog is generated and machine-introspectable … resolving the map's fog question: **yes**") conflated two layers, as later measured against lark-cli 1.0.87 (decision record: [ADR-0019 measurement addendum](../adr/0019-in-process-http-sole-substrate-lark-cli-build-time-oracle.md), [#58](https://github.com/0xnicholas/totem/issues/58)):

- `lark-cli schema` introspects the **task-oriented typed-command catalog only** — 246 commands over 15 services — **not** the 2,500-endpoint raw layer. The raw layer (`lark-cli api`) has no introspection and no offline path validation.
- Schema entries carry **no HTTP path and no method** — CLI-flag-level params only — so endpoint-level diffing (the drift oracle #54 appended to its verdict) is impossible by construction on this corpus.
- The `docs`/`base` domains (totem's core surface) are `+shortcut` orchestrations without schema entries; **zero of totem's 16 upstream paths map into the corpus**.

The runtime facts in §§1–4 stand as measured. The fog question has a narrower answer than recorded here: the *typed command* corpus is machine-introspectable; the *endpoint* corpus is not.
