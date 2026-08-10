import { describe, expect, it } from 'vitest';
import { ActionError } from '../src/errors.js';
import { DEFAULT_RATE_LIMIT_PER_MINUTE, RateLimiter } from '../src/rate-limit.js';
import { FakeConnector } from '../src/testing/fake-connector.js';
import { CONN_1, CONN_1_A, CONN_1_B, TENANT_A, TENANT_B, makeHarness } from './fixtures.js';

function harnessWith(limiter: RateLimiter, rateLimit?: { requestsPerMinute: number }) {
  const connector = new FakeConnector([], rateLimit ? { rateLimit } : {});
  return makeHarness({ connectors: [connector], rateLimiter: limiter });
}

/**
 * Rate limiting at Seam A (T13): a per-(tenant, connection) token bucket at
 * the execution boundary, capacity declared by the connector manifest
 * (Falcon's per-linked-account mainRatelimit analog), platform default when
 * undeclared. Exhaustion is a `rate_limited` vocabulary error carrying
 * `retryAfterSeconds` — the agent's retry signal (ADR-0005 `retryable`).
 */
describe('rate limiting at Seam A (T13)', () => {
  it('rejects with rate_limited and retryAfterSeconds once the connection bucket is exhausted, and audits the attempt', async () => {
    const now = 1_000_000;
    const harness = harnessWith(new RateLimiter({ now: () => now }), {
      requestsPerMinute: 2,
    });
    const args = { title: 'Q3 planning', content: 'Draft outline' };

    // Two tokens available: both calls pass.
    for (let i = 0; i < 2; i++) {
      const result = await harness.executor.executeAction(TENANT_A, CONN_1, 'create_doc', args);
      expect(result.ok).toBe(true);
    }

    // Third call within the same instant: bucket empty. The denial is a
    // vocabulary error with the wait time the agent should honor
    // (capacity 2/min → refill 1/30 per second → 30s to a full token).
    const denied = await harness.executor.executeAction(TENANT_A, CONN_1, 'create_doc', args);
    expect(denied.ok).toBe(false);
    if (denied.ok) return;
    expect(denied.error).toBeInstanceOf(ActionError);
    expect(denied.error.code).toBe('rate_limited');
    expect(denied.error.retryable).toBe(true);
    expect(denied.error.retryAfterSeconds).toBe(30);

    // The attempt is attributable and audited like any other failure.
    const rows = harness.audit.list();
    expect(rows.at(-1)).toMatchObject({
      tenantId: TENANT_A,
      connectionId: CONN_1,
      actionName: 'create_doc',
      success: false,
      errorCode: 'rate_limited',
    });
  });

  it('applies the platform default budget when the connector declares none', async () => {
    const now = 2_000_000;
    const harness = harnessWith(new RateLimiter({ now: () => now }));
    const args = { title: 't', content: 'c' };

    // The full default burst passes (600/min → refill 10/s → 1s to one token).
    for (let i = 0; i < DEFAULT_RATE_LIMIT_PER_MINUTE; i++) {
      const result = await harness.executor.executeAction(TENANT_A, CONN_1, 'create_doc', args);
      expect(result.ok).toBe(true);
    }

    const denied = await harness.executor.executeAction(TENANT_A, CONN_1, 'create_doc', args);
    expect(denied.ok).toBe(false);
    if (denied.ok) return;
    expect(denied.error.code).toBe('rate_limited');
    expect(denied.error.retryAfterSeconds).toBe(1);
  });

  it('keeps buckets isolated per (tenant, connection)', async () => {
    const now = 3_000_000;
    const harness = makeHarness({
      connectors: [new FakeConnector([], { rateLimit: { requestsPerMinute: 2 } })],
      connections: [CONN_1_A, CONN_1_B],
      rateLimiter: new RateLimiter({ now: () => now }),
    });
    const args = { title: 't', content: 'c' };

    // Tenant A burns its whole budget.
    await harness.executor.executeAction(TENANT_A, CONN_1, 'create_doc', args);
    await harness.executor.executeAction(TENANT_A, CONN_1, 'create_doc', args);
    const denied = await harness.executor.executeAction(TENANT_A, CONN_1, 'create_doc', args);
    expect(denied.ok).toBe(false);

    // Tenant B's connection has its own bucket: still fully allowed.
    const b1 = await harness.executor.executeAction(TENANT_B, CONN_1, 'create_doc', args);
    expect(b1.ok).toBe(true);
    const b2 = await harness.executor.executeAction(TENANT_B, CONN_1, 'create_doc', args);
    expect(b2.ok).toBe(true);
  });

  it('refills the bucket and admits again after retryAfterSeconds', async () => {
    let now = 4_000_000;
    const harness = harnessWith(new RateLimiter({ now: () => now }), {
      requestsPerMinute: 2,
    });
    const args = { title: 't', content: 'c' };

    await harness.executor.executeAction(TENANT_A, CONN_1, 'create_doc', args);
    await harness.executor.executeAction(TENANT_A, CONN_1, 'create_doc', args);
    const denied = await harness.executor.executeAction(TENANT_A, CONN_1, 'create_doc', args);
    expect(denied.ok).toBe(false);
    if (denied.ok) return;
    expect(denied.error.retryAfterSeconds).toBe(30);

    // After the advertised wait, one token has refilled (2/min → 1 per 30s).
    now += (denied.error.retryAfterSeconds ?? 0) * 1000;
    const retried = await harness.executor.executeAction(TENANT_A, CONN_1, 'create_doc', args);
    expect(retried.ok).toBe(true);
  });
});
