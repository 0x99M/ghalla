import { describe, expect, it } from 'vitest';
import {
  FailureLimiter,
  GLOBAL_LIMIT,
  PER_SOURCE_LIMIT,
  checkLogin,
  createLoginLimiter,
  recordLoginFailure,
  recordLoginSuccess,
} from '../src/lib/auth/rate-limit';

const NOW = 1_800_000_000_000;

describe('FailureLimiter', () => {
  const options = { maxFailures: 3, windowMs: 1000, blockMs: 500 };

  it('allows an untouched key', () => {
    expect(new FailureLimiter(options).check('a', NOW)).toEqual({ allowed: true, retryAfterMs: 0 });
  });

  it('blocks once the failures reach the limit inside the window', () => {
    const limiter = new FailureLimiter(options);
    expect(limiter.recordFailure('a', NOW).allowed).toBe(true);
    expect(limiter.recordFailure('a', NOW).allowed).toBe(true);
    expect(limiter.recordFailure('a', NOW)).toEqual({ allowed: false, retryAfterMs: 500 });
    expect(limiter.check('a', NOW).allowed).toBe(false);
  });

  it('lifts the block when it expires', () => {
    const limiter = new FailureLimiter(options);
    for (let i = 0; i < 3; i += 1) limiter.recordFailure('a', NOW);
    expect(limiter.check('a', NOW + 499).allowed).toBe(false);
    expect(limiter.check('a', NOW + 500).allowed).toBe(true);
  });

  it('does not re-trip immediately on failures it already punished', () => {
    const limiter = new FailureLimiter(options);
    for (let i = 0; i < 3; i += 1) limiter.recordFailure('a', NOW);
    // One failure after the block lifts must not instantly re-block: the count
    // restarts with the block, or a source is effectively banned for good.
    expect(limiter.recordFailure('a', NOW + 500).allowed).toBe(true);
  });

  it('forgets failures older than the window', () => {
    const limiter = new FailureLimiter(options);
    limiter.recordFailure('a', NOW);
    limiter.recordFailure('a', NOW);
    expect(limiter.recordFailure('a', NOW + 1000).allowed).toBe(true);
  });

  it('keeps keys apart', () => {
    const limiter = new FailureLimiter(options);
    for (let i = 0; i < 3; i += 1) limiter.recordFailure('a', NOW);
    expect(limiter.check('b', NOW).allowed).toBe(true);
  });

  it('clears a key on success', () => {
    const limiter = new FailureLimiter(options);
    limiter.recordFailure('a', NOW);
    limiter.recordFailure('a', NOW);
    limiter.clear('a');
    expect(limiter.recordFailure('a', NOW).allowed).toBe(true);
  });

  it('prunes idle keys, because the key space is client addresses', () => {
    const limiter = new FailureLimiter(options);
    limiter.recordFailure('a', NOW);
    expect(limiter.size).toBe(1);
    limiter.prune(NOW + 500);
    expect(limiter.size).toBe(1);
    limiter.prune(NOW + 1000);
    expect(limiter.size).toBe(0);
  });

  it('does not prune a key that is still blocked', () => {
    const limiter = new FailureLimiter({ maxFailures: 1, windowMs: 100, blockMs: 10_000 });
    limiter.recordFailure('a', NOW);
    limiter.prune(NOW + 5000);
    expect(limiter.size).toBe(1);
    expect(limiter.check('a', NOW + 5000).allowed).toBe(false);
  });
});

describe('the two tiers', () => {
  it('cuts off one noisy source before the global limit is anywhere near', () => {
    // The whole point of the per-source tier: it fires at 5, the global one at
    // 20, so a single bad actor is stopped without touching everybody else.
    expect(PER_SOURCE_LIMIT.maxFailures).toBeLessThan(GLOBAL_LIMIT.maxFailures);
  });

  it('blocks a source that exhausts the per-source allowance', () => {
    const limiter = createLoginLimiter();
    for (let i = 0; i < PER_SOURCE_LIMIT.maxFailures; i += 1) recordLoginFailure(limiter, '1.2.3.4', NOW);
    expect(checkLogin(limiter, '1.2.3.4', NOW).allowed).toBe(false);
    expect(checkLogin(limiter, '5.6.7.8', NOW).allowed).toBe(true);
  });

  it('blocks EVERY source once the global allowance is gone', () => {
    // A single shared secret means the source is irrelevant to an attacker who
    // can rotate addresses, which is exactly what the second tier is for.
    const limiter = createLoginLimiter();
    for (let i = 0; i < GLOBAL_LIMIT.maxFailures; i += 1) recordLoginFailure(limiter, `10.0.0.${String(i)}`, NOW);
    expect(checkLogin(limiter, 'a-brand-new-address', NOW).allowed).toBe(false);
  });

  it('reports the longer of the two waits', () => {
    const limiter = createLoginLimiter();
    for (let i = 0; i < GLOBAL_LIMIT.maxFailures; i += 1) recordLoginFailure(limiter, `10.0.0.${String(i)}`, NOW);
    expect(checkLogin(limiter, '10.0.0.1', NOW).retryAfterMs).toBeGreaterThan(0);
  });

  it('lets a correct key clear its own source but NOT the global count', () => {
    // Otherwise one successful login by the operator wipes the record of
    // everybody else's failures — the state an attacker would most like the
    // counter to be in.
    const limiter = createLoginLimiter();
    for (let i = 0; i < GLOBAL_LIMIT.maxFailures; i += 1) recordLoginFailure(limiter, `10.0.0.${String(i)}`, NOW);
    recordLoginSuccess(limiter, '10.0.0.1');
    expect(checkLogin(limiter, '10.0.0.1', NOW).allowed).toBe(false);
  });

  it('allows a clean attempt', () => {
    expect(checkLogin(createLoginLimiter(), '1.2.3.4', NOW)).toEqual({ allowed: true, retryAfterMs: 0 });
  });
});
