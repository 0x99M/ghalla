import type { Instant } from '@ghalla/contracts';
import type { Subscription } from './subscription.js';

/**
 * Usage is DERIVED, never counted.
 *
 * A counter is a second copy of a fact the orders table already holds, and it
 * drifts the moment anything is not a clean single delivery: a retried webhook
 * increments twice, a replay increments again, a backfill increments fifty
 * thousand times, a refund decrements something that a cancellation already
 * decremented. Every one of those is a normal event here, and the merchant
 * discovers the drift as a cap they hit at 900 orders.
 *
 * The count is one indexed aggregate over a table we are already writing. It
 * cannot drift, because there is nothing for it to drift from.
 */

/** The half-open window a period covers: `[start, end)`. */
export interface UsageWindow {
  readonly from: Instant;
  readonly to: Instant;
}

/** The two fields a usage window is made of. See `PlanState` for why this is a `Pick`. */
export type BillingPeriod = Pick<Subscription, 'currentPeriodStart' | 'currentPeriodEnd'>;

/**
 * Half-open, and that is the whole reason this type exists rather than passing
 * two dates around. An order placed on the final millisecond of a period
 * belongs to that period; one placed on the first millisecond of the next
 * belongs to the next. A closed interval counts the boundary order twice —
 * once against a cap the merchant has already paid for and once against the one
 * they just renewed.
 */
export function usageWindow(subscription: BillingPeriod): UsageWindow {
  return { from: subscription.currentPeriodStart, to: subscription.currentPeriodEnd };
}

export interface UsageStatus {
  readonly count: number;
  /** `null` is unlimited. */
  readonly cap: number | null;
  readonly overCap: boolean;
  /** `null` when unlimited. Never negative — an over-cap store has zero left, not minus forty. */
  readonly remaining: number | null;
  /** `null` when unlimited. Rounded down, and NOT clamped: 140% is the number that motivates an upgrade. */
  readonly percentUsed: number | null;
}

export function usageStatus(count: number, cap: number | null): UsageStatus {
  if (cap === null) {
    return { count, cap: null, overCap: false, remaining: null, percentUsed: null };
  }
  return {
    count,
    cap,
    // Strictly greater: a merchant on exactly their 300th order of a 300-order
    // plan is AT the cap and has had everything they paid for. Telling them
    // they are over it is both wrong and a bad first impression of the upsell.
    overCap: count > cap,
    remaining: Math.max(0, cap - count),
    percentUsed: cap === 0 ? null : Math.floor((count / cap) * 100),
  };
}

/**
 * The cache key.
 *
 * `periodStart` is in the key, so a renewal starts a fresh count with no
 * invalidation step — the old key simply stops being asked for and ages out.
 * The PLAN is deliberately NOT in the key: the count does not depend on the
 * plan, only the cap does, and the cap is resolved from the subscription row on
 * every request. A merchant who upgrades mid-period therefore sees the new cap
 * on their next page load without anything being invalidated at all.
 *
 * That is the difference between this and an explicit-invalidation design, and
 * it is why there is no invalidation call anywhere in this package: the only
 * thing cached is a number that a plan change does not affect.
 */
export function usageCacheKey(storeId: string, window: UsageWindow): string {
  return `usage:${storeId}:${window.from}`;
}

export interface CacheEntry {
  readonly value: number;
  readonly expiresAt: number;
}

/**
 * A TTL cache with the clock passed IN.
 *
 * In-process, not Redis. That is a direct consequence of the queue decision in
 * docs/0006 — we run no Redis — and it is defensible here for a reason that
 * does not apply to a queue: this number drives a BANNER, not enforcement.
 * Nothing is denied on the strength of it. So the cost of each replica holding
 * its own copy is that two replicas may briefly disagree about whether to show
 * an upgrade prompt, which is not a cost worth a second stateful system.
 *
 * What it must not become is the thing a limit is enforced from. If usage ever
 * gates an action rather than decorating a page, this has to move to a shared
 * store first — and at that point the queue's own trigger condition has
 * probably fired too.
 *
 * `now` is a parameter rather than a `Date.now()` call so the expiry is
 * testable at the boundary instead of with a sleep.
 */
export class UsageCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly ttlMs: number;

  // Assigned in the body rather than declared as a parameter property: the
  // library tsconfig sets `erasableSyntaxOnly`, so every type annotation has to
  // be strippable without changing runtime behaviour, and a parameter property
  // is not.
  constructor(ttlMs = 300_000) {
    this.ttlMs = ttlMs;
  }

  get(key: string, now: number): number | null {
    const entry = this.entries.get(key);
    if (entry === undefined) return null;
    if (entry.expiresAt <= now) {
      // Dropped on read rather than swept. The key space is one entry per
      // active store per period, so it is bounded by the customer count and a
      // sweeper would be machinery for a map that never grows.
      this.entries.delete(key);
      return null;
    }
    return entry.value;
  }

  set(key: string, value: number, now: number): void {
    this.entries.set(key, { value, expiresAt: now + this.ttlMs });
  }

  /**
   * For the plan-change path and for tests.
   *
   * Kept even though the key design means a plan change does not need it: an
   * operator correcting a store's data by hand has no other way to make the
   * banner catch up, and telling them to wait five minutes is worse than one
   * method.
   */
  invalidate(key: string): void {
    this.entries.delete(key);
  }

  get size(): number {
    return this.entries.size;
  }
}
