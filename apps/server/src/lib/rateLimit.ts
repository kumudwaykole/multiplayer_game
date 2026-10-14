import { performance } from 'node:perf_hooks';

export interface TakeResult {
  ok: boolean;
  retryAfterMs: number;
}

/** Classic token bucket: `capacity` is the burst, `refillPerSec` the sustained rate. */
export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(
    readonly capacity: number,
    readonly refillPerSec: number,
    now = performance.now(),
  ) {
    this.tokens = capacity;
    this.last = now;
  }

  /** Reports whether `cost` tokens are available without spending them. */
  check(cost = 1, now = performance.now()): TakeResult {
    this.refill(now);
    if (this.tokens >= cost) return { ok: true, retryAfterMs: 0 };
    return { ok: false, retryAfterMs: Math.ceil(((cost - this.tokens) / this.refillPerSec) * 1000) };
  }

  take(cost = 1, now = performance.now()): TakeResult {
    const result = this.check(cost, now);
    if (result.ok) this.tokens -= cost;
    return result;
  }

  /** True when the bucket is full again, so a keyed limiter can forget it. */
  isFull(now = performance.now()): boolean {
    this.refill(now);
    return this.tokens >= this.capacity;
  }

  private refill(now: number): void {
    const elapsed = Math.max(0, now - this.last) / 1000;
    this.last = now;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerSec);
  }
}

export interface BucketSpec {
  capacity: number;
  refillPerSec: number;
}

/** Spends `cost` from every bucket only when all of them allow it. */
export function takeAll(buckets: readonly TokenBucket[], cost = 1, now = performance.now()): TakeResult {
  let retryAfterMs = 0;
  for (const bucket of buckets) {
    const result = bucket.check(cost, now);
    if (!result.ok) retryAfterMs = Math.max(retryAfterMs, result.retryAfterMs);
  }
  if (retryAfterMs > 0) return { ok: false, retryAfterMs };
  for (const bucket of buckets) bucket.take(cost, now);
  return { ok: true, retryAfterMs: 0 };
}

/** Per-key buckets (IP, session) with eviction of keys whose bucket refilled. */
export class KeyedRateLimiter {
  private readonly buckets = new Map<string, TokenBucket>();

  constructor(
    private readonly spec: BucketSpec,
    private readonly maxKeys = 100_000,
  ) {}

  take(key: string, cost = 1): TakeResult {
    let bucket = this.buckets.get(key);
    if (!bucket) {
      if (this.buckets.size >= this.maxKeys) this.sweep();
      bucket = new TokenBucket(this.spec.capacity, this.spec.refillPerSec);
      this.buckets.set(key, bucket);
    }
    return bucket.take(cost);
  }

  sweep(): void {
    const now = performance.now();
    for (const [key, bucket] of this.buckets) {
      if (bucket.isFull(now)) this.buckets.delete(key);
    }
  }
}
