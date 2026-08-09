# ADR-0001: Actions are defined by the platform, not by connectors

**Status:** Accepted

**Date:** 2025-08-09

## Context

Totem's value proposition is a *unified action layer*: AI agents act on real systems (Feishu Docs in v1) through a curated, schema-first set of actions. The core design tension is where action definitions live — in the platform's action registry, or in each connector.

If connectors define their own actions, the registry merely collects them, and the "unified" vocabulary is an illusion: each connector drifts its own semantics, allowlists must be configured per connector, and agents must learn per-system vocabularies. This defeats the product's reason to exist.

## Decision

- **The platform owns action definitions.** The action registry is the single source of truth for every action: `name`, `description` (written for an LLM audience), `inputSchema`, `outputSchema`.
- **Connectors declare what they implement.** Each connector carries a manifest: `{ id, implements: string[] }`. The same action name across connectors (v2: DingTalk, etc.) has identical input/output schemas — only the translation differs.
- **Allowlists are configured by unified action name**, never by connector-specific names.
- **IDs exposed to agents are unified opaque IDs.** The platform exposes `doc_id: string` (opaque); the connector translates it to system-internal tokens (Feishu docx token). v1 may trivially use the Feishu token as the opaque ID, but the contract is platform-level: the connector is responsible for parse/format.
- **v1 action schemas do not support connector-specific extension parameters** (no `x-connector-params` escape hatch). Connector-specific needs are either mapped into unified concepts (`folder_id`) or handled in connection configuration/ctx. If the platform vocabulary genuinely cannot express something, the correct move is to upgrade the platform schema — not open a bypass.

## Consequences

- **Positive:** agents learn one vocabulary; allowlists and audit are connector-agnostic; adding a connector in v2 does not change any action schema.
- **Negative:** action schema design must happen at the platform level with care (this is real design work, not transcription); connectors must fit their system into the platform vocabulary, which can occasionally require creative mapping.
- The registry retains the full action set for admin query; the MCP exposure filters per-connection availability (see ADR-0002).
