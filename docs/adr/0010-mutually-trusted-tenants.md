# ADR-0010: Mutually-trusted tenants — admin-scope keys are platform credentials for now

**Status:** Accepted

**Date:** 2026-08-10

## Context

Totem's consumers are the operator's own internal projects (CONTEXT.md:
"an internal platform, no SaaS, no second-level customer"). The admin
surface authenticates two credential kinds: the platform admin key
(`TOTEM_ADMIN_KEY`) and admin-scoped tenant keys (`create-key --scope
admin`). The admin middleware accepts either; neither is checked against
the tenant in the route path — an admin-scope key resolves to
`{tenantId, keyId}` at auth time (`findAdminKey`) but every `/admin`
route uses the `:tenantId` path parameter without an ownership check.

Consequence today: an admin-scope tenant key is equivalent to the
platform admin key — it can create tenants, read any tenant's audit
trail, replace any connection's allowlist or app credentials, flip
audit/defender policies, and start OAuth flows for any tenant. This was
flagged as a tenant-isolation gap (per-tenant admin keys should only
manage their own tenant), with tenant-scoped isolation proposed as the
enabler for safe self-service onboarding.

Decision point 2026-08-10: the operator has exactly one consuming
project today, and the next projects to join are all owned by the same
organization and mutually trusted. Building tenant-scoped admin
isolation now would be speculative machinery for a threat model that
does not exist yet.

## Decision

1. **Tenants are mutually trusted.** All consuming projects are operated
   by the same organization; there is no trust boundary between tenants
   in v1. Isolation of *action execution* (connections, allowlists,
   audit attribution, rate-limit buckets) remains fully tenant-scoped —
   this ADR is only about the admin surface.
2. **Admin-scope tenant keys are the official self-service onboarding
   credential**, carrying platform-admin equivalence. They are issued to
   mutually-trusted projects so those projects can onboard themselves
   (create keys, register app credentials, run the authorize flow, set
   allowlists) without an operator ticket.
3. **No tenant-ownership check is added to `/admin` routes now.** The
   current behavior is a deliberate contract, not a known bug; the audit
   trail (`source: admin_api`) still records which key did what.
4. **Tenant isolation of the admin surface is deferred** until a
   non-trusted consumer exists (or the trust circle grows beyond what
   the operator is comfortable with). When it lands, it should be the
   minimal middleware check — path `:tenantId` must equal the resolved
   admin key's `tenantId` — plus the equivalent change in `totemctl`.

## Consequences

- **Positive:** consuming projects can self-onboard end to end; no
  operator bottleneck for the common lifecycle (new connection,
  re-auth, allowlist change); no speculative isolation machinery to
  build, test, or maintain; the audit trail keeps every admin mutation
  attributable even without isolation.
- **Negative:** any project holding an admin-scope key can affect any
  other project's admin state (allowlist, credentials, policies,
  audit visibility). This is accepted because all holders are
  mutually trusted; it must be revisited when the first non-trusted
  consumer joins. The integration guide documents the trust boundary
  explicitly so holders do not mistake the key for a tenant-scoped one.
