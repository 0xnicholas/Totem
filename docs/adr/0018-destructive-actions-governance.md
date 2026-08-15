# ADR-0018: Destructive actions — governance semantics before the first delete

**Status:** Accepted

**Date:** 2026-08-15

## Context

`ActionEffect.destructive` has been reserved since T10 (mapped to MCP
`destructiveHint`) but no action ever carried it. #44 lands the first two:

- `delete_doc` — canonical, destructive (Feishu drive delete, async task).
- `feishu_delete_bitable_records` — provider-native, destructive (Feishu
  batch delete, ≤500 records per call).

Deleting is a different risk class from writing: a hijacked or wrong agent
call is **irreversible from the platform's world** (upstream trash recovery
is a human upstream operation, not an agent capability). Per the batch's
grilling record, the governance semantics are decided here, before the
actions land. Four axes: allowlist defaults, Defender tiering, audit
presentation, consumption-standard classification.

A note on honesty: Feishu's drive delete moves files to the system's trash
(a user may restore upstream). The class stays `destructive` — the glossary
definition is "irreversible" *from the platform's and agent's world*, not
"thermodynamically unrecoverable by a human upstream".

## Decision

### 1. Allowlist: one gate, default-deny, explicit acknowledge at write

- **Default-deny is structural, unchanged.** New connections carry an empty
  allowlist; an empty allowlist denies everything (fail-closed). There are
  no wildcards and no seeded default sets. Destructive actions therefore
  never enter a connection implicitly — this standing policy is now
  recorded as covering the destructive class explicitly.
- **Explicit acknowledge at the only write point.** `PUT
  /admin/connections/:id/allowlist` must carry `allowDestructive: true`
  when the submitted list includes any registered destructive action;
  otherwise the request fails 400 naming the offending names. Rationale:
  the realistic accident is a broad copy-pasted allowlist sweeping a
  destructive name in. The flag is the "rm confirm" placed at the single
  mutation point, not a second runtime gate — the executor's allowlist
  check stays the one enforcement seam (same decider: the operator; one
  gate: the allowlist; zero new store columns).
- The acknowledge flag rides the allowlist-update audit row automatically
  (admin mutations audit their params), so the opting-in act is itself
  audited.

### 2. Defender tiering: input screening, fail-closed for the destructive class

ADR-0009's tripwire scans **responses** at the return path — observe-first,
blocking opt-in (`blockHighRisk`). For destructive actions the return path
is too late: the deletion already happened. Tiering decision:

- **Destructive actions also scan their input `args`** at the execution
  boundary, before token acquisition and dispatch — same Tier-1 signature
  set, same 1 MiB size guard, same per-tenant `enabled` knob (a tenant
  that disables Defender disables input screening too; one policy module,
  not two).
- **Fail-closed for the class:** a high-risk input detection returns
  `forbidden` with `details.reason = 'defender_block'` **regardless of
  `blockHighRisk`** — the only place Defender blocks by default. The
  asymmetry justifies departing from observe-first here: a false positive
  costs one agent turn; a false negative is an irreversible upstream
  deletion. `blockHighRisk` continues to govern the response path for
  read/write actions only.
- Scan metadata rides the audit row as usual (the observation path), with
  a `path: 'input'` discriminator alongside the response scan's implicit
  output-path shape, so operators can tell which side tripped.

### 3. Audit presentation: stamped, exempt from error-only, filterable

- Every destructive execution attempt — success or failure, any error code
  — stamps `metadata.effects = 'destructive'` (merged with Defender
  metadata when present). Stamping at write time records what the platform
  classified at execution time; deriving from the live registry at query
  time would drift as the catalog evolves.
- **Destructive successes are exempt from error-only audit mode (T11):**
  the `errorOnly` shortcut skips success rows, but "which documents did
  the agents delete" is exactly the question the audit log must always
  answer. Error-only tenants still skip non-destructive successes.
- Operator surfaces: `GET /admin/tenants/:id/audit?destructive=true`
  filters stamped rows; `totemctl query-audit --destructive true` and a
  `DESTRUCTIVE` marker in the CLI row output.

### 4. Consumption standard: the effect class is public contract

The standard documents `effects` as consumer-visible metadata
(`GET /actions`, OpenAPI) with the three classes and their meaning;
`destructive` = irreversible upstream state change. MCP projects it as
`destructiveHint` (unchanged since T10). Agent-facing call semantics do
NOT change: same envelope, same error vocabulary, `forbidden` when not
allowlisted — an agent that sees a destructive tool should treat it with
user confirmation per its own policy; the platform guarantees only that
destructive actions are never implicitly allowlisted. Effects
reclassification remains a major change (§11.2, ADR-0014).

## Rejected alternatives

- **Tenant-level `destructive_enabled` runtime gate** — a second
  governance knob beside the allowlist: two places to check, two failure
  modes, same decider. Rejected; the acknowledge flag gives the intent
  signal at the write point instead.
- **Separate destructive-allowlist endpoint** — more surface, same
  semantics as a body flag.
- **Dedicated `audit_logs.destructive` column** — metadata is the
  established free-form enrichment channel (T15); a jsonb containment
  filter serves the operator query without a migration.
- **Observe-only input screening for the class** — rejected on the
  asymmetry argument above; deferred blocking would ship the tripwire
  with its most valuable case turned off.

## Consequences

- `delete_doc` and `feishu_delete_bitable_records` enter the catalog with
  governance semantics already pinned: they are allowlisted only by
  acknowledged act, input-screened fail-closed, and always audited.
- The admin allowlist API gains a required flag for destructive lists
  (backward compatible: no destructive actions existed before this batch,
  so no caller can break).
- DingTalk does not implement `delete_doc` in this batch — a coverage gap
  (§11.1 of the standard), like `export_doc` before it.
- Future destructive actions inherit this contract by declaring
  `effects: 'destructive'`; no per-action governance wiring is needed.
