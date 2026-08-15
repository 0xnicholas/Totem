# ADR-0019: In-process HTTP is the sole connector execution substrate; lark-cli is a build-time oracle

**Status:** Accepted

**Date:** 2026-08-15

## Context

The runtime-facts research ([#52](https://github.com/0xnicholas/totem/issues/52), `docs/research/lark-cli-runtime-facts.md`) established that lark-cli is headless-capable: direct token injection via env vars, a wire-stable typed error envelope on stderr with category exit codes, raw-layer passthrough of upstream errors, MIT-licensed Go binary on the official SDK, checksum-verified. The constraints an engine adoption would have feared — keychain-only auth, interactive-only login, opaque errors — do not hold. The adjudication ([#54](https://github.com/0xnicholas/totem/issues/54)) therefore turned on other grounds.

Cross-check against the codebase: 18 actions, Feishu connector at ~975 lines — the per-action cost is curation (input/output schemas, output shaping, allowlist semantics, audit, tests), not transport; the Upstream HTTP Kernel makes the fetch itself ~free per family (one ~30-line profile). There is no live pain a shelled-out engine would relieve.

The decision is **platform-wide by construction**: it rules the substrate for every connector, not Feishu alone, because ADR-0003's premise is that connector authors learn one interface *and* one runtime shape.

## Decision

- **The Upstream HTTP Kernel — in-process HTTP — is the sole execution substrate for every connector, present and future. Connectors never shell out to CLI processes at runtime.**
- **What would have survived (recorded so nobody re-litigates from the fear side):** env-token injection would have kept ADR-0015's single Token Lifecycle (the token from `ctx` rides an env var; no keychain, no sidecar); the CLI's 9-category envelope maps cleanly into the seven unified codes (ADR-0005) — arguably cleaner than raw Feishu codes; Defender (ADR-0009) is transport-blind at Seam A. The no does **not** rest on impossibility.
- **The decisive grounds:** (1) *a second governor* — lark-cli's cmdpolicy YAML risk engine, dry-run, and per-command risk annotations sit between totem's allowlist and the Upstream, violating single-authority governance; a layer that exists only to be configured permissive is a liability, and its diagnostics/hints would leak into agent-facing messages unless stripped. (2) *a spawn-failure taxonomy* — ENOENT, timeout, SIGKILL, zombie reaping, stdio backpressure — a whole error class with no vocabulary slot (all collapse to `upstream_error`). (3) *asymmetry* — no dingtalk-cli or wecom-cli exists, so a yes was executable for one connector of three, the exact split the platform-wide rule exists to prevent. (4) *no live pain* to buy relief for. Additionally, CLI-side automation (`--page-all`, per-process pacing) would have had to be pinned off anyway: it conflicts with the List Envelope cursor contract (ADR-0012) and the platform throttle (T13).
- **Build time: ~~adopt the corpus, not the runtime~~ (retracted — see Measurement addendum).** lark-cli becomes a pinned devDependency with zero runtime footprint. Its machine-introspectable command catalog (`lark-cli schema`) is the **Endpoint Corpus** (CONTEXT.md): committed snapshot fixture, regenerated deliberately when the pinned version bumps — that refresh PR is the drift-review moment. CI **blocks** when a connector-referenced endpoint path, HTTP method, or param name is missing from the corpus (typo or upstream rename — both real breakage); coverage stats are informational, never blocking (the catalog is deliberately curated, not exhaustive). The corpus is an oracle, never a generator: no codegen, no schema synthesis — registry ownership stays with the platform (ADR-0001, ADR-0014).
- **Dev-probing convention:** developers running lark-cli interactively (probing endpoints during action curation) do so under their **own Feishu user identity** via the device flow, through a **dedicated dev custom app**, against a sandbox/non-production workspace. Never platform-held App Credentials, never a tenant connection's token — those live encrypted in Postgres and serve only the Token Lifecycle (ADR-0015). User identity also matches runtime reality: the connector executes as the connection user.
- **Flip condition (single, both halves required):** coverage economics invert — ≥50 provider-native `feishu_*` actions in the registry, **and** protocol-quirk fixes (envelope/param/error-classification changes in connector handlers) >50% of connector-dir commits over the trailing quarter. When both hold, supersede this ADR; process model and cross-family asymmetry are then migration design questions, not blockers to evaluation.

## Consequences

- **Positive:** one runtime failure taxonomy across all connectors; governance stays single-authority (allowlist at the Execution Boundary, nothing between it and the Upstream); no vendor-binary runtime dependency or release-cadence coupling; the #52 research still pays out as CI drift detection; credential hygiene stays in one module.
- **Negative:** protocol quirks (envelope churn, error-code reclassification, pacing headers) remain totem's to maintain per family in the kernel profile; ~~the corpus fixture needs deliberate refresh~~ (oracle retracted); the 2,500-endpoint coverage upside is consciously declined until the flip bar is met.

## Measurement addendum (2026-08-15): build-time oracle retracted

Implementation probing ([#58](https://github.com/0xnicholas/totem/issues/58)) falsified the oracle's premise. Measured against lark-cli 1.0.87, committed as the decision record in #58:

- `lark-cli schema` dumps a **task-oriented typed-command catalog: 246 commands over 15 services** (approval, attendance, calendar, contact, drive, im, mail, mindnotes, minutes, okr, sheets, slides, task, vc, wiki) — not the 2,500-endpoint raw layer, which has no introspection (`lark-cli api` performs no offline path validation; `--dry-run` fails at the config stage before any validation).
- **Entries carry no HTTP path and no method** — only CLI-flag-level param schemas — so path/method diffing is impossible by construction, and param mapping would target flags, not HTTP params.
- **The `docs` and `base` domains are task-level `+shortcut` orchestrations** (e.g. `+media-insert` is a four-step orchestration), not schema'd API methods.
- **Zero of the connector's 16 distinct upstream paths map into the corpus**: no `docx`/`bitable`/`suite` services; sheets covers filters only (no values/data-range endpoints); drive lacks `export_tasks`/`search`/`batch_query`/`create`; `im messages` has no `create` (send).

**Disposition:** the build-time clause above is retracted — a blocking drift oracle cannot be built on this corpus, and a zero-coverage oracle is theater. lark-cli is **not** a devDependency (its postinstall downloads a Go binary into every `npm ci`/CI run for zero scripted use); developers probe interactively via `npx @larksuite/cli@1.0.87` under the dev-probing convention above. The runtime verdict, its grounds, and the flip condition are unchanged. **Reopen condition:** `lark-cli schema` starts covering raw HTTP paths/methods or the docx/bitable/suite services — then rebuild the oracle decision on measured coverage, not on this retraction.

## Rejected alternatives

- **Shell out for provider-native actions only (hybrid):** two substrates *and* two error paths inside one connector family; the native actions are precisely the ones needing curated errors most.
- **Live `lark-cli schema` invocation in CI:** network-dependent, implicit corpus version, upstream renames red-flake main instead of surfacing in a reviewable refresh PR.
- **Advisory-only oracle:** a warning nobody is forced to read is how drift reaches production; the check's value is that it can say no.
- **Codegen from the corpus:** blurs platform ownership of action schemas (ADR-0001) and the registry change policy (ADR-0014) — vendor corpora must not set totem's schemas.
