import { describe, expect, it } from 'vitest';
import { toInstant } from '@ghalla/contracts';
import type { Instant, StoreId, SubscriptionStatus } from '@ghalla/contracts';
import { decideAccess, isPaying, isTrialExpired } from '../src/access.js';
import { cheapestPlanWith, hasFeature, resolveEntitlements } from '../src/entitlements.js';
import { FEATURES, PLANS, PLAN_CODES, TRIAL_DAYS, isPlanCode, planOf } from '../src/plans.js';
import type { Subscription } from '../src/subscription.js';

const at = (iso: string): Instant => toInstant(iso);
const NOW = at('2026-03-15T00:00:00.000Z');

const subscription = (over: Partial<Subscription> = {}): Subscription => ({
  storeId: 'demo:1' as StoreId,
  planCode: 'growth',
  platformPlanId: 'plat_2',
  status: 'active',
  trialEndsAt: null,
  currentPeriodStart: at('2026-03-01T00:00:00.000Z'),
  currentPeriodEnd: at('2026-04-01T00:00:00.000Z'),
  lastEventAt: null,
  lastReconciledAt: null,
  ...over,
});

describe('the plan table', () => {
  it('never lets a plan be silently unlimited by accident', () => {
    // `null` is unlimited and `0` would be "no orders at all". Anything else
    // must be a positive integer — a fractional or negative cap is a typo that
    // would either lock everyone out or never trigger.
    for (const code of PLAN_CODES) {
      const cap = PLANS[code].orderCap;
      if (cap !== null) {
        expect(Number.isInteger(cap)).toBe(true);
        expect(cap).toBeGreaterThan(0);
      }
    }
  });

  it('gives every plan the core feature', () => {
    // A plan that cannot see its own profit numbers is not a plan.
    for (const code of PLAN_CODES) expect(PLANS[code].features).toContain('core');
  });

  it('declares only features the product knows about', () => {
    for (const code of PLAN_CODES) {
      for (const feature of PLANS[code].features) expect(FEATURES).toContain(feature);
    }
  });

  it('runs cheapest-first, which the upgrade prompt depends on', () => {
    // `cheapestPlanWith` walks declaration order. If this ordering is ever
    // shuffled, merchants get upsold to the wrong tier and nothing else fails.
    expect(PLAN_CODES[0]).toBe('starter');
    expect(PLANS.starter.orderCap).toBeLessThan(PLANS.growth.orderCap);
    expect(PLANS.scale.orderCap).toBeNull();
  });

  it('trials run 14 days, not 7', () => {
    // Value only appears after the backfill finishes AND the merchant has
    // entered enough cost data to clear a useful coverage percentage. That is
    // several days of intermittent effort on their side.
    expect(TRIAL_DAYS).toBe(14);
  });

  it('answers null for a plan code this build does not know', () => {
    // A rollback to an image older than the plan. Degrading beats a 500 on the
    // merchant's dashboard.
    expect(planOf('growth_v9')).toBeNull();
    expect(isPlanCode('growth_v9')).toBe(false);
    expect(isPlanCode('growth')).toBe(true);
  });

  it('does not mistake an inherited Object property for a plan', () => {
    // `'constructor' in PLANS` is true. A plan lookup that used `in` would
    // resolve `constructor` to a function and take `.features` off it.
    expect(isPlanCode('constructor')).toBe(false);
    expect(planOf('toString')).toBeNull();
  });
});

describe('the behaviour table', () => {
  const rows: { status: SubscriptionStatus; over: boolean; dashboard: string; ingestion: string }[] = [
    { status: 'trialing', over: false, dashboard: 'full', ingestion: 'running' },
    { status: 'active', over: false, dashboard: 'full', ingestion: 'running' },
    { status: 'active', over: true, dashboard: 'full', ingestion: 'running' },
    { status: 'past_due', over: false, dashboard: 'full', ingestion: 'running' },
    { status: 'expired', over: false, dashboard: 'read_only', ingestion: 'running' },
    { status: 'canceled', over: false, dashboard: 'locked', ingestion: 'stopped' },
  ];

  for (const row of rows) {
    it(`${row.status}${row.over ? ' over cap' : ''}: dashboard ${row.dashboard}, ingestion ${row.ingestion}`, () => {
      const decision = decideAccess(subscription({ status: row.status }), NOW, row.over);
      expect(decision.dashboard).toBe(row.dashboard);
      expect(decision.ingestion).toBe(row.ingestion);
      // Profit computation follows ingestion everywhere. Computing without
      // ingesting produces figures from a partial order set, which is worse
      // than none.
      expect(decision.profitComputation).toBe(row.ingestion);
    });
  }

  it('keeps ingesting over the order cap', () => {
    // Overage compute costs cents. A silently incomplete dashboard destroys
    // trust in the numbers, and the numbers are the entire product.
    const decision = decideAccess(subscription({ status: 'active' }), NOW, true);
    expect(decision.ingestion).toBe('running');
    expect(decision.notice).toBe('over_order_cap');
  });

  it('treats past_due exactly like active', () => {
    // Payment retries frequently succeed. Cutting off a merchant over a card
    // that expired on Tuesday, when the bank authorises on Thursday, turns a
    // billing hiccup into a churn event.
    const decision = decideAccess(subscription({ status: 'past_due' }), NOW, false);
    expect(decision.dashboard).toBe('full');
    expect(decision.ingestion).toBe('running');
    expect(decision.notice).toBe('payment_past_due');
    expect(isPaying('past_due')).toBe(true);
  });

  it('shows the cap notice ahead of the payment notice when both apply', () => {
    // One banner. The cap is the one with an upgrade path attached.
    expect(decideAccess(subscription({ status: 'past_due' }), NOW, true).notice).toBe('over_order_cap');
  });

  it('keeps ingesting after a trial expires, and makes the dashboard read-only', () => {
    // If they subscribe two weeks later their history is complete and correct.
    // That is a conversion advantage, not a cost — the alternative is asking
    // someone to pay for a dashboard with a fortnight missing from the middle.
    const expired = subscription({ status: 'trialing', trialEndsAt: at('2026-03-01T00:00:00.000Z') });
    const decision = decideAccess(expired, NOW, false);
    expect(isTrialExpired(expired, NOW)).toBe(true);
    expect(decision.dashboard).toBe('read_only');
    expect(decision.ingestion).toBe('running');
    expect(decision.profitComputation).toBe('running');
    expect(decision.notice).toBe('trial_expired');
  });

  it('leaves a trial alone right up to its final instant', () => {
    const ending = subscription({ status: 'trialing', trialEndsAt: NOW });
    expect(isTrialExpired(ending, NOW)).toBe(false);
    expect(decideAccess(ending, NOW, false).dashboard).toBe('full');
  });

  it('does not expire a trial that has no end date', () => {
    expect(isTrialExpired(subscription({ status: 'trialing', trialEndsAt: null }), NOW)).toBe(false);
  });

  it('ignores a stale trial end on a subscription that has since gone active', () => {
    // The trial ended, and they paid. The trial date is history, not a verdict.
    const converted = subscription({ status: 'active', trialEndsAt: at('2026-01-01T00:00:00.000Z') });
    expect(isTrialExpired(converted, NOW)).toBe(false);
    expect(decideAccess(converted, NOW, false).dashboard).toBe('full');
  });

  it('keeps export available in every state, canceled included', () => {
    // A merchant who can leave with their data is more likely to come back, and
    // one who cannot will say so publicly.
    for (const status of ['trialing', 'active', 'past_due', 'expired', 'canceled'] as const) {
      expect(decideAccess(subscription({ status }), NOW, false).export).toBe('available');
    }
  });

  it('stops the pipeline for canceled and nothing else', () => {
    for (const status of ['trialing', 'active', 'past_due', 'expired'] as const) {
      expect(decideAccess(subscription({ status }), NOW, false).ingestion).toBe('running');
    }
    expect(decideAccess(subscription({ status: 'canceled' }), NOW, false).ingestion).toBe('stopped');
    expect(isPaying('canceled')).toBe(false);
    expect(isPaying('expired')).toBe(false);
  });
});

describe('resolving entitlements', () => {
  it('carries the plan’s features and cap onto the request', () => {
    const resolved = resolveEntitlements(subscription({ planCode: 'ads' }), NOW, false);
    expect(resolved.features).toStrictEqual(['core', 'attribution', 'ltv', 'reports']);
    expect(resolved.orderCap).toBeNull();
    expect(resolved.planUnknown).toBe(false);
    expect(hasFeature(resolved, 'attribution')).toBe(true);
  });

  it('fails CLOSED on an unknown plan, and says so', () => {
    // Failing open would make "write a plan code nobody recognises" a way to
    // obtain the top tier. Falling back to starter keeps the blast radius to a
    // locked-looking screen, which is the reversible kind of wrong.
    const resolved = resolveEntitlements(subscription({ planCode: 'enterprise_v7' }), NOW, false);
    expect(resolved.planUnknown).toBe(true);
    expect(resolved.features).toStrictEqual(['core']);
    expect(resolved.orderCap).toBe(PLANS.starter.orderCap);
    expect(hasFeature(resolved, 'attribution')).toBe(false);
    // The code itself is preserved so the log line names what was actually in
    // the row, not what we substituted.
    expect(resolved.planCode).toBe('enterprise_v7');
  });

  it('does not let a billing state remove a feature the plan includes', () => {
    // A canceled store on `ads` still HAS attribution; it simply cannot reach
    // the dashboard, which `access` already decided. Folding the two questions
    // together is what produces a guard denying a feature because a card
    // bounced.
    const resolved = resolveEntitlements(subscription({ planCode: 'ads', status: 'past_due' }), NOW, false);
    expect(hasFeature(resolved, 'attribution')).toBe(true);
    expect(resolved.access.dashboard).toBe('full');
  });

  it('names the cheapest plan carrying a feature, for the upgrade prompt', () => {
    // A bare 403 makes the merchant guess what to buy. Naming the tier turns a
    // dead end into a checkout link.
    expect(cheapestPlanWith('core')).toBe('starter');
    expect(cheapestPlanWith('attribution')).toBe('ads');
    expect(cheapestPlanWith('reports')).toBe('ads');
  });

  it('answers null when no plan carries a feature', () => {
    expect(cheapestPlanWith('nonexistent' as never)).toBeNull();
  });
});
