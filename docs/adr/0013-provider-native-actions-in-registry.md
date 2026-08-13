# ADR-0013: Provider-native actions in the registry — declaration, naming, advertisement, promotion

**Status:** Accepted

**Date:** 2026-08-13

## Context

Provider-specific capabilities (Feishu bitable, DingTalk-only features) need
a governed way into the action catalog. Research
(`docs/research/stackone-unified-models.md`, #35) established the industry
pattern: provider-specific capability ⇒ a provider-scoped action with
provider-shaped output inside the governed catalog (StackOne's `custom`
actionType) — not canonical-set stretching, not raw passthrough.

The decision was already live when made: `read_bitable_records` /
`write_bitable_records` had landed as bare canonical names implemented only
by the feishu connector, and `export_doc` was (and stays) a canonical action
that dingtalk has not implemented. The registry had no way to say "this
action belongs to one provider", and ADR-0001's "no connector-specific
extensions — upgrade the platform schema instead" left the upgrade mechanism
unspecified. This ADR is that mechanism: a provider-native action is a
*platform-owned* declaration kind, not a connector bypass.

Grilling record: #36 (2026-08-13).

## Decision

- **Declaration.** `Action` gains an optional `provider` field
  (`'feishu' | 'dingtalk'`, the provider token). Absent means *canonical* —
  any connector may implement it. Present means *provider-native* — only
  connectors of that provider may implement it. `ConnectorManifest` gains a
  matching `provider` field.
- **Registry enforcement** at registration time: a provider-native action
  may only appear in the `implements` list of connectors with the same
  `provider`; its name must start with `<provider>_`; a canonical action's
  name must not carry a known provider prefix.
- **Output semantics stay curated.** Provider-native actions follow every
  platform invariant: platform-owned input/output schemas, opaque IDs,
  unified error vocabulary, full schema validation, Defender screening.
  Scope limits *availability and vocabulary*, never governance invariants.
  No raw provider passthrough (StackOne deprecated `/unified/proxy`; totem
  adds none), no connector escape hatch (ADR-0001's no-bypass rule extends
  to provider-native actions).
- **Naming.** Provider-native actions are `<provider>_` + the verb_noun
  name the action would have canonically: `feishu_read_bitable_records`.
  The two landed bitable actions are renamed in the same change as this
  ADR (`read_bitable_records` → `feishu_read_bitable_records`,
  `write_bitable_records` → `feishu_write_bitable_records`) — a one-time
  bootstrap before the change policy of ADR-0014 takes effect, while the
  only consumers are two mutually-trusted internal projects (ADR-0010).
  `export_doc` stays a canonical bare name: dingtalk's missing
  implementation is a *coverage gap* (absence from `implements`), not
  scope.
- **MCP advertisement.** The mechanism is unchanged: a connection's tool
  list is registry ∩ allowlist ∩ connector `implements` − hidden
  (ADR-0002), so a connection only ever sees provider-native actions its
  own connector implements. The name prefix is the agent-facing scope
  signal; the structured `provider` field is exposed on `GET /actions` for
  tooling. Tool descriptions carry no scope marking. Allowlist, audit, and
  Defender treat provider-native actions identically to canonical ones.
- **Promotion path.** When a second provider gains a genuinely unifiable
  equivalent, add a *new* canonical action with a unified schema and
  deprecate the provider-native one per ADR-0014 (`replacement` +
  `sunset`). Provider-native names are never renamed, never reused, and a
  provider-native action never grows a second implementer in place — the
  scope check forbids it, and keeping the `feishu_` name on a
  cross-provider action would be a lie.

## Consequences

- **Positive:** bitable-class capabilities have a governed growth path that
  keeps audit, allowlist, and MCP semantics uniform; the canonical set
  stays honest about what is actually unified; scope is machine-readable
  (registry validation, metadata endpoint), not reviewer convention.
- **Negative:** the registry carries a new concept plus validation rules;
  the provider token list must be maintained as connectors are added;
  promotion creates temporary duplication (a canonical action and its
  deprecated native predecessor coexist for the sunset window).
- ADR-0001 is amended: its "upgrade the platform schema" clause now points
  here — the upgrade is a platform-owned provider-scoped definition.
- Deprecation machinery and the removal rules referenced above are defined
  in ADR-0014.
