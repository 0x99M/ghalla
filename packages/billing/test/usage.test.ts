import { describe, expect, it } from 'vitest';
import { toInstant } from '@ghalla/contracts';
import type { Instant, StoreId } from '@ghalla/contracts';
import { UsageCache, usageCacheKey, usageStatus, usageWindow } from '../src/usage.js';
import type { Subscription } from '../src/subscription.js';

const at = (iso: string): Instant => toInstant(iso);

const subscription = (over: Partial<Subscription> = {}): Subscription => ({
  storeId: 'demo:1' as StoreId,
  planCode: 'starter',
  platformPlanId: null,
  status: 'active',
  trialEndsAt: null,
  currentPeriodStart: at('2026-03-01T00:00:00.000Z'),
  currentPeriodEnd: at('2026-04-01T00:00:00.000Z'),
  lastEventAt: null,
  lastReconciledAt: null,
  ...over,
});

describe('the counting window', () => {
  it('is the subscription period, not a calendar month', () => {
    // A merchant who subscribed on the 17th is billed on the 17th, and metering
    // them on the 1st would give them a short first period and a free tail.
    const window = usageWindow(subscription({
      currentPeriodStart: at('2026-03-17T09:30:00.000Z'),
      currentPeriodEnd: at('2026-04-17T09:30:00.000Z'),
    }));
    expect(window.from).toBe(at('2026-03-17T09:30:00.000Z'));
    expect(window.to).toBe(at('2026-04-17T09:30:00.000Z'));
  });
});

describe('the cap', () => {
  it('is not exceeded by an order that exactly reaches it', () => {
    // The 300th order of a 300-order plan is one the merchant paid for. Telling
    // them they are over is both wrong and a poor first impression of the
    // upsell.
    const status = usageStatus(300, 300);
    expect(status.overCap).toBe(false);
    expect(status.remaining).toBe(0);
    expect(status.percentUsed).toBe(100);
  });

  it('is exceeded by the next one', () => {
    expect(usageStatus(301, 300).overCap).toBe(true);
  });

  it('never reports negative headroom', () => {
    // "minus forty orders remaining" is not a thing to put in front of anyone.
    expect(usageStatus(340, 300).remaining).toBe(0);
  });

  it('reports the true percentage past the cap, unclamped', () => {
    // 113% is the number that motivates an upgrade. Clamping it to 100% hides
    // exactly the merchants worth talking to.
    expect(usageStatus(340, 300).percentUsed).toBe(113);
  });

  it('treats null as unlimited, never as zero', () => {
    const status = usageStatus(50_000, null);
    expect(status.overCap).toBe(false);
    expect(status.remaining).toBeNull();
    expect(status.percentUsed).toBeNull();
  });

  it('does not divide by a zero cap', () => {
    // Not a plan we ship, but a plan table is edited by hand and this returns
    // Infinity rather than a number if nothing guards it.
    expect(usageStatus(5, 0).percentUsed).toBeNull();
    expect(usageStatus(5, 0).overCap).toBe(true);
  });
});

describe('the cache key', () => {
  it('changes when the period rolls, so a renewal starts a fresh count', () => {
    const march = usageCacheKey('demo:1', usageWindow(subscription()));
    const april = usageCacheKey(
      'demo:1',
      usageWindow(subscription({
        currentPeriodStart: at('2026-04-01T00:00:00.000Z'),
        currentPeriodEnd: at('2026-05-01T00:00:00.000Z'),
      })),
    );
    expect(march).not.toBe(april);
  });

  it('does NOT change when the plan does', () => {
    // Deliberate, and it is what makes a mid-period upgrade take effect
    // immediately without any invalidation. The COUNT does not depend on the
    // plan — only the cap does, and the cap is read from the subscription row
    // on every request. So the cached number stays valid and the new cap is
    // applied to it on the very next page load.
    const starter = usageCacheKey('demo:1', usageWindow(subscription({ planCode: 'starter' })));
    const scale = usageCacheKey('demo:1', usageWindow(subscription({ planCode: 'scale' })));
    expect(starter).toBe(scale);
  });

  it('keeps stores apart', () => {
    expect(usageCacheKey('demo:1', usageWindow(subscription()))).not.toBe(
      usageCacheKey('demo:2', usageWindow(subscription())),
    );
  });
});

describe('the usage cache', () => {
  it('returns a value inside its TTL', () => {
    const cache = new UsageCache(300_000);
    cache.set('k', 42, 1_000);
    expect(cache.get('k', 200_000)).toBe(42);
  });

  it('expires exactly at the TTL, not after it', () => {
    const cache = new UsageCache(300_000);
    cache.set('k', 42, 0);
    expect(cache.get('k', 299_999)).toBe(42);
    expect(cache.get('k', 300_000)).toBeNull();
  });

  it('drops an expired entry rather than keeping it around', () => {
    const cache = new UsageCache(1_000);
    cache.set('k', 1, 0);
    expect(cache.size).toBe(1);
    cache.get('k', 5_000);
    expect(cache.size).toBe(0);
  });

  it('misses cleanly on a key it has never seen', () => {
    expect(new UsageCache().get('nothing', 0)).toBeNull();
  });

  it('can be invalidated by hand', () => {
    // Not needed by the plan-change path — the key design covers that — but an
    // operator who has just corrected a store's data by hand has no other way
    // to make the banner catch up.
    const cache = new UsageCache();
    cache.set('k', 7, 0);
    cache.invalidate('k');
    expect(cache.get('k', 0)).toBeNull();
  });

  it('defaults to a five-minute TTL', () => {
    const cache = new UsageCache();
    cache.set('k', 1, 0);
    expect(cache.get('k', 299_000)).toBe(1);
    expect(cache.get('k', 300_001)).toBeNull();
  });
});
