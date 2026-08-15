# Dev-time probing with lark-cli

The convention for using lark-cli interactively while curating Feishu actions. The decision record is [ADR-0019](../adr/0019-in-process-http-sole-substrate-lark-cli-build-time-oracle.md); this page is the operational how-to. lark-cli is a probing tool only — never a runtime or build-time dependency of the platform.

## Identity

- **Your own Feishu user**, via the device flow (`lark-cli auth login`). The laptop keychain is the CLI's designed store and is fine — a dev-laptop credential, not a platform credential.
- Under a **dedicated dev custom app** (its own app_id/secret), against a **sandbox / non-production tenant and workspace**.
- **Never** platform-held App Credentials, and **never** a tenant connection's token — those live encrypted in Postgres and serve only the [Token Lifecycle](../../CONTEXT.md). Probing as the connection user matches runtime reality: the connector executes with the connection user's identity.

## Invocation

```
npx @larksuite/cli@1.0.87 <command>
```

No devDependency (its postinstall downloads a Go binary into every `npm ci`; the pin above keeps probe runs reproducible instead). Prefer typed commands (`lark-cli <domain> --help`); `lark-cli api` is the raw escape hatch; `lark-cli schema <service.resource.method>` inspects a command's params before calling.

## Hygiene rules

1. **`--dry-run` first for any destructive probe** — it renders the exact HTTP request (method, path, body) without executing, the same exact-request-preview spirit as ADR-0018's governance semantics.
2. **Dev app + sandbox space only** — never point a probe at a production tenant or workspace, even a read-only one.
3. **Probe artifacts stay out of the repo** — tokens, signed URLs, and raw response dumps (which may carry tenant data) never enter commits, issues, or docs. Findings land as prose in tickets or research docs, not as pasted payloads.

## When to reach for what

| Need | Reach for |
|---|---|
| An endpoint's params, identities, scopes | `lark-cli schema` first, then Open Platform docs for the normative text |
| Behavior of an edge case (empty body, error shape) | lark-cli probe under this convention |
| Envelope/pacing mechanics already documented | Open Platform docs — don't burn a probe on documented facts |
| One-off HTTP check of a non-Feishu system | curl — lark-cli is Feishu-only |
