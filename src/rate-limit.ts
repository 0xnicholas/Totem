/**
 * Rate limiting at the execution boundary (T13): a per-(tenant, connection)
 * token bucket that turns a declared requests-per-minute budget into a
 * `rate_limited` vocabulary error with `retryAfterSeconds` — the agent's
 * retry signal (ADR-0005). The bucket is the platform's fair-share and
 * self-protection primitive; it is deliberately minimal: no queueing, no
 * platform-side auto-retry (agents retry on `retryable: true`).
 *
 * The limit's source of truth is the connector manifest
 * (`ConnectorManifest.rateLimit`, per connected account — Falcon's
 * `mainRatelimit` analog); `DEFAULT_RATE_LIMIT_PER_MINUTE` applies when a
 * connector does not declare one.
 */
export interface RateLimitDeclaration {
  /** Requests per minute for one connection. */
  requestsPerMinute: number;
}

/** Platform fallback when a connector declares no rate limit (T13). */
export const DEFAULT_RATE_LIMIT_PER_MINUTE = 600;

export interface RateLimitCheck {
  allowed: boolean;
  /** Whole seconds the caller should wait before retrying (present when denied). */
  retryAfterSeconds?: number;
}

interface Bucket {
  tokens: number;
  capacity: number;
  lastRefillAt: number;
  lastUsedAt: number;
}

/** Idle full buckets are dropped after this long without use. */
const PRUNE_IDLE_MS = 5 * 60 * 1000;
/** Opportunistic sweep once the map grows past this size. */
const PRUNE_ABOVE_SIZE = 10_000;

/**
 * In-memory token bucket keyed by an opaque string (the executor keys by
 * tenant + connection). Capacity equals the per-minute budget (one minute's
 * worth of burst), refilled at budget/60 per second. The clock is injectable
 * so tests can exhaust and refill buckets deterministically.
 */
export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly now: () => number;

  constructor(opts: { now?: () => number } = {}) {
    this.now = opts.now ?? Date.now;
  }

  /**
   * Consumes one token when available. When the bucket is empty, returns the
   * whole-second wait until one token exists (the refill rate is
   * capacity/60 per second, so the wait is `ceil((1 - tokens) / rate)`).
   */
  check(key: string, requestsPerMinute: number): RateLimitCheck {
    const nowMs = this.now();
    const capacity = requestsPerMinute;

    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { tokens: capacity, capacity, lastRefillAt: nowMs, lastUsedAt: nowMs };
      this.buckets.set(key, bucket);
    } else {
      // Lazy cleanup: a bucket that is full and long idle will never deny a
      // request again — drop it instead of holding the entry forever.
      if (bucket.tokens >= bucket.capacity && nowMs - bucket.lastUsedAt > PRUNE_IDLE_MS) {
        this.buckets.delete(key);
        bucket = { tokens: capacity, capacity, lastRefillAt: nowMs, lastUsedAt: nowMs };
        this.buckets.set(key, bucket);
      }
    }

    const elapsedSec = (nowMs - bucket.lastRefillAt) / 1000;
    if (elapsedSec > 0) {
      bucket.tokens = Math.min(bucket.capacity, bucket.tokens + elapsedSec * (bucket.capacity / 60));
      bucket.lastRefillAt = nowMs;
    }
    bucket.lastUsedAt = nowMs;

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return { allowed: true };
    }
    const missing = 1 - bucket.tokens;
    const retryAfterSeconds = Math.ceil(missing / (bucket.capacity / 60));
    return { allowed: false, retryAfterSeconds };
  }

  /** Drops buckets that are full and idle; bounded sweep for long-running servers. */
  prune(): void {
    if (this.buckets.size < PRUNE_ABOVE_SIZE) return;
    const nowMs = this.now();
    for (const [key, bucket] of this.buckets) {
      if (bucket.tokens >= bucket.capacity && nowMs - bucket.lastUsedAt > PRUNE_IDLE_MS) {
        this.buckets.delete(key);
      }
    }
  }
}
