/**
 * A fixed-window failure counter, in process.
 *
 * What it is actually for is worth being clear about, because it is easy to
 * overstate. With a 32-character key enforced at startup, brute force is not a
 * threat this defends against — no rate limit turns a feasible attack into an
 * infeasible one, and no absence of one turns an infeasible attack into a
 * feasible one. What it does buy:
 *
 *   - a weak key, if one ever gets set despite the length check, is not free to
 *     attack at line rate;
 *   - a misbehaving script does not fill the log with a thousand failures a
 *     second and bury the one line that matters.
 *
 * Two tiers, and the reason for both is the same single shared secret. A
 * per-source limit is what usually stops an attacker, but a shared secret means
 * the source is irrelevant — so there is a global limit behind it. The global
 * one is also the one that could lock the operator out, which is why the block
 * is measured in a minute rather than an hour: locking out the only person who
 * can fix anything is its own outage.
 *
 * In process, so it resets on deploy and is per-instance. Both are acceptable
 * for a limit that is defence in depth rather than the defence.
 */

export interface LimitDecision {
  readonly allowed: boolean;
  /** Milliseconds until the caller may try again. Zero when allowed. */
  readonly retryAfterMs: number;
}

interface Bucket {
  failures: number;
  /** When the counting window began. */
  windowStartedAt: number;
  /** When the block lifts, or 0 when not blocked. */
  blockedUntil: number;
}

export interface LimiterOptions {
  readonly maxFailures: number;
  readonly windowMs: number;
  readonly blockMs: number;
}

export const PER_SOURCE_LIMIT: LimiterOptions = {
  maxFailures: 5,
  windowMs: 15 * 60 * 1000,
  blockMs: 60 * 1000,
};

/**
 * Higher than the per-source limit, so a single noisy source is cut off by the
 * tier above before it can trip the one that affects everybody.
 */
export const GLOBAL_LIMIT: LimiterOptions = {
  maxFailures: 20,
  windowMs: 15 * 60 * 1000,
  blockMs: 60 * 1000,
};

export class FailureLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly options: LimiterOptions;

  constructor(options: LimiterOptions) {
    this.options = options;
  }

  check(key: string, now: number): LimitDecision {
    const bucket = this.buckets.get(key);
    if (bucket === undefined || bucket.blockedUntil <= now) {
      return { allowed: true, retryAfterMs: 0 };
    }
    return { allowed: false, retryAfterMs: bucket.blockedUntil - now };
  }

  /** Called on a FAILED attempt only. A success is not evidence of anything to limit. */
  recordFailure(key: string, now: number): LimitDecision {
    const existing = this.buckets.get(key);
    const bucket: Bucket =
      existing === undefined || now - existing.windowStartedAt >= this.options.windowMs
        ? { failures: 0, windowStartedAt: now, blockedUntil: 0 }
        : existing;

    bucket.failures += 1;
    if (bucket.failures >= this.options.maxFailures) {
      bucket.blockedUntil = now + this.options.blockMs;
      // The window restarts with the block, so a blocked source does not
      // re-trip the instant its block lifts on the strength of failures it
      // has already been punished for.
      bucket.failures = 0;
      bucket.windowStartedAt = now;
    }
    this.buckets.set(key, bucket);

    return bucket.blockedUntil > now
      ? { allowed: false, retryAfterMs: bucket.blockedUntil - now }
      : { allowed: true, retryAfterMs: 0 };
  }

  /** Called on success, so a correct key clears the failures that preceded it. */
  clear(key: string): void {
    this.buckets.delete(key);
  }

  /**
   * Drops buckets that are neither blocked nor inside their window.
   *
   * The key space is client addresses, which is unbounded — without this a
   * long-running process accumulates one entry per address that ever guessed
   * wrong. Called on each attempt rather than on a timer, because a limiter
   * that needs its own scheduler is a limiter that stops working when the
   * scheduler does.
   */
  prune(now: number): void {
    for (const [key, bucket] of this.buckets) {
      const idle = now - bucket.windowStartedAt >= this.options.windowMs;
      if (idle && bucket.blockedUntil <= now) this.buckets.delete(key);
    }
  }

  get size(): number {
    return this.buckets.size;
  }
}

export const GLOBAL_KEY = 'global';

export interface LoginLimiterDeps {
  readonly perSource: FailureLimiter;
  readonly global: FailureLimiter;
}

export function createLoginLimiter(): LoginLimiterDeps {
  return { perSource: new FailureLimiter(PER_SOURCE_LIMIT), global: new FailureLimiter(GLOBAL_LIMIT) };
}

/** Both tiers, checked together. The stricter answer wins. */
export function checkLogin(limiter: LoginLimiterDeps, source: string, now: number): LimitDecision {
  limiter.perSource.prune(now);
  const perSource = limiter.perSource.check(source, now);
  const global = limiter.global.check(GLOBAL_KEY, now);
  if (perSource.allowed && global.allowed) return { allowed: true, retryAfterMs: 0 };
  return { allowed: false, retryAfterMs: Math.max(perSource.retryAfterMs, global.retryAfterMs) };
}

export function recordLoginFailure(limiter: LoginLimiterDeps, source: string, now: number): void {
  limiter.perSource.recordFailure(source, now);
  limiter.global.recordFailure(GLOBAL_KEY, now);
}

/**
 * A success clears the per-source count but NOT the global one.
 *
 * Otherwise one correct login from the operator would wipe the evidence of
 * everybody else's failures, which is exactly the state an attacker would like
 * the counter to be in.
 */
export function recordLoginSuccess(limiter: LoginLimiterDeps, source: string): void {
  limiter.perSource.clear(source);
}
