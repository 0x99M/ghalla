import { describe, expect, it } from 'vitest';
import { toInstant } from '@ghalla/contracts';
import type { Instant, StoreId } from '@ghalla/contracts';
import {
  MONTHS_FREE_ON_ANNUAL,
  PLANS,
  PLAN_CODES,
  cheapestPlanWith,
  isDowngrade,
  monthlyCapOf,
  planOf,
} from '../src/plans.js';
import type { Plan, PlanCode } from '../src/plans.js';
import { applyChange, effectivePlanCode } from '../src/subscription.js';
import { resolveEntitlements } from '../src/entitlements.js';
import type { Subscription, SubscriptionChange } from '../src/subscription.js';

const at = (iso: string): Instant => toInstant(iso);
const MARCH = at('2026-03-01T00:00:00.000Z');
const APRIL = at('2026-04-01T00:00:00.000Z');

const subscription = (over: Partial<Subscription> = {}): Subscription => ({
  storeId: 'demo:1' as StoreId,
  planCode: 'growth',
  platformPlanId: 'plat_2',
  status: 'active',
  trialEndsAt: null,
  currentPeriodStart: MARCH,
  currentPeriodEnd: APRIL,
  lastEventAt: at('2026-03-05T00:00:00.000Z'),
  lastReconciledAt: null,
  pendingPlanCode: null,
  pendingPlanEffectiveAt: null,
  ...over,
});

const change = (over: Partial<SubscriptionChange> = {}): SubscriptionChange => ({
  status: 'active',
  planCode: null,
  platformPlanId: null,
  trialEndsAt: null,
  currentPeriodStart: null,
  currentPeriodEnd: null,
  occurredAt: at('2026-03-15T00:00:00.000Z'),
  ...over,
});

describe('annual plans', () => {
  const annual = PLAN_CODES.filter((code) => PLANS[code].interval === 'year');

  it('exist for every monthly plan', () => {
    const monthly = PLAN_CODES.filter((code) => PLANS[code].interval === 'month');
    expect(annual).toHaveLength(monthly.length);
  });

  it('buy a longer period, never a smaller allowance', () => {
    // The cap covers a BILLING PERIOD. An annual plan whose cap was not scaled
    // would be a twelvefold cut disguised as a discount — a merchant on
    // growth_annual would hit 1,500 orders in January and be over cap for
    // eleven months.
    for (const code of annual) {
      const plan: Plan = PLANS[code];
      const twin = planOf(plan.monthlyEquivalent ?? '');
      expect(twin).not.toBeNull();
      if (twin === null) continue;
      expect(monthlyCapOf(plan)).toBe(monthlyCapOf(twin));
    }
  });

  it('entitle exactly what their monthly twin entitles', () => {
    // Annual is a billing TERM, not a tier. A feature appearing on one and not
    // the other would make the discount a silent upgrade or a silent cut.
    for (const code of annual) {
      const plan: Plan = PLANS[code];
      const twin = planOf(plan.monthlyEquivalent ?? '');
      expect(twin?.features).toStrictEqual(plan.features);
    }
  });

  it('are their own codes, never a flag on the monthly plan', () => {
    // The grandfathering rule: a merchant's row names a code, and that code's
    // meaning must never change under them.
    expect(PLANS.growth.interval).toBe('month');
    expect(PLANS.growth_annual.interval).toBe('year');
    expect(PLANS.growth_annual.orderCap).toBe(PLANS.growth.orderCap * 12);
  });

  it('give two months free', () => {
    // Pay for ten, get twelve. The charge itself is configured at the platform,
    // which is the only place an amount is authoritative — this is the intent.
    expect(MONTHS_FREE_ON_ANNUAL).toBe(2);
  });

  it('are not what an upgrade prompt offers', () => {
    // A merchant hitting a locked feature is deciding in the moment, and a
    // twelve-month commitment is a bigger ask than the feature is worth right
    // then. Annual is something to offer once they have stayed.
    expect(cheapestPlanWith('attribution')).toBe('ads');
    expect(PLANS[cheapestPlanWith('core') as PlanCode].interval).toBe('month');
  });
});

describe('telling an upgrade from a downgrade', () => {
  it('calls a smaller cap a downgrade', () => {
    expect(isDowngrade(PLANS.growth, PLANS.starter)).toBe(true);
  });

  it('calls a bigger cap an upgrade', () => {
    expect(isDowngrade(PLANS.starter, PLANS.growth)).toBe(false);
  });

  it('treats unlimited as the top', () => {
    expect(isDowngrade(PLANS.scale, PLANS.growth)).toBe(true);
    expect(isDowngrade(PLANS.growth, PLANS.scale)).toBe(false);
    expect(isDowngrade(PLANS.scale, PLANS.ads)).toBe(false);
  });

  it('calls losing a feature a downgrade whatever the cap does', () => {
    // ads → scale keeps an unlimited cap and loses attribution, ltv and
    // reports. Comparing caps alone would call that a lateral move.
    expect(isDowngrade(PLANS.ads, PLANS.scale)).toBe(true);
  });

  it('does not call a switch to annual a change at all', () => {
    // Same tier, longer term. Comparing raw caps would read 1,500 → 18,000 as a
    // twelvefold upgrade one way and a cut the other; normalising to a monthly
    // rate is what makes both directions honest.
    expect(isDowngrade(PLANS.growth, PLANS.growth_annual)).toBe(false);
    expect(isDowngrade(PLANS.growth_annual, PLANS.growth)).toBe(false);
  });

  it('still sees a tier drop across a term change', () => {
    expect(isDowngrade(PLANS.growth_annual, PLANS.starter)).toBe(true);
    expect(isDowngrade(PLANS.starter, PLANS.growth_annual)).toBe(false);
  });
});

describe('an upgrade mid-cycle', () => {
  it('takes effect immediately', () => {
    // The platform charges the prorated difference on the spot. Provisioning
    // late is the single most visible way to make a paid upgrade feel broken:
    // the merchant has the receipt and not the feature.
    const outcome = applyChange(
      subscription({ planCode: 'growth' }),
      change({ planCode: 'ads', platformPlanId: 'plat_9' }),
    );
    expect(outcome.kind).toBe('applied');
    if (outcome.kind !== 'applied') return;
    expect(outcome.next.planCode).toBe('ads');
    expect(outcome.next.pendingPlanCode).toBeNull();
  });

  it('unlocks the feature on the very next read', () => {
    const upgraded = applyChange(subscription({ planCode: 'growth' }), change({ planCode: 'ads' }));
    if (upgraded.kind !== 'applied') return;
    const entitlements = resolveEntitlements(upgraded.next, at('2026-03-15T00:00:01.000Z'), false);
    expect(entitlements.features).toContain('attribution');
  });

  it('takes a reset billing period from the event when the platform sends one', () => {
    // The platform may preserve the original renewal date or start a fresh
    // 30-day cycle on the upgrade date. Either is fine because we follow what
    // the event says — and the usage cache keys on period start, so a reset
    // begins a fresh count with nothing to invalidate.
    const outcome = applyChange(
      subscription({ planCode: 'growth' }),
      change({
        planCode: 'ads',
        currentPeriodStart: at('2026-03-15T00:00:00.000Z'),
        currentPeriodEnd: at('2026-04-14T00:00:00.000Z'),
      }),
    );
    if (outcome.kind !== 'applied') return;
    expect(outcome.next.currentPeriodStart).toBe(at('2026-03-15T00:00:00.000Z'));
    expect(outcome.next.currentPeriodEnd).toBe(at('2026-04-14T00:00:00.000Z'));
  });

  it('cancels a downgrade the merchant had already scheduled', () => {
    // They changed their mind. Leaving the pending row would drop them back a
    // tier at period end despite having just paid to move up.
    const scheduled = subscription({
      planCode: 'growth',
      pendingPlanCode: 'starter',
      pendingPlanEffectiveAt: APRIL,
    });
    const outcome = applyChange(scheduled, change({ planCode: 'ads' }));
    if (outcome.kind !== 'applied') return;
    expect(outcome.next.planCode).toBe('ads');
    expect(outcome.next.pendingPlanCode).toBeNull();
    expect(outcome.next.pendingPlanEffectiveAt).toBeNull();
  });
});

describe('a downgrade mid-cycle', () => {
  const downgraded = applyChange(subscription({ planCode: 'ads' }), change({ planCode: 'starter' }));

  it('does NOT take effect immediately', () => {
    // The platform does not refund the unused remainder, so the merchant has
    // paid for the higher tier through to the end of the cycle. Applying the
    // lower plan when the webhook lands takes away something already bought.
    expect(downgraded.kind).toBe('applied');
    if (downgraded.kind !== 'applied') return;
    expect(downgraded.next.planCode).toBe('ads');
    expect(downgraded.next.pendingPlanCode).toBe('starter');
    expect(downgraded.next.pendingPlanEffectiveAt).toBe(APRIL);
  });

  it('leaves the features working until the period ends', () => {
    if (downgraded.kind !== 'applied') return;
    const stillPaid = resolveEntitlements(downgraded.next, at('2026-03-31T23:59:59.000Z'), false);
    expect(stillPaid.planCode).toBe('ads');
    expect(stillPaid.features).toContain('attribution');
  });

  it('takes effect the instant the period does end', () => {
    if (downgraded.kind !== 'applied') return;
    const after = resolveEntitlements(downgraded.next, APRIL, false);
    expect(after.planCode).toBe('starter');
    expect(after.features).toStrictEqual(['core']);
    expect(after.orderCap).toBe(PLANS.starter.orderCap);
  });

  it('needs no job to flip it', () => {
    // Computed at read time on purpose. A cron that has to fire at the exact
    // second a period rolls over is a cron that will one day not fire, and the
    // merchant then keeps a tier they stopped paying for — or, with the timing
    // reversed, loses one they still own.
    if (downgraded.kind !== 'applied') return;
    expect(effectivePlanCode(downgraded.next, at('2026-03-20T00:00:00.000Z'))).toBe('ads');
    expect(effectivePlanCode(downgraded.next, at('2026-04-02T00:00:00.000Z'))).toBe('starter');
  });

  it('applies at once when the period has already ended', () => {
    // This is the renewal happening, not a deferral. There is nothing left to
    // defer to.
    const outcome = applyChange(
      subscription({ planCode: 'ads' }),
      change({ planCode: 'starter', occurredAt: at('2026-04-01T00:00:01.000Z') }),
    );
    if (outcome.kind !== 'applied') return;
    expect(outcome.next.planCode).toBe('starter');
    expect(outcome.next.pendingPlanCode).toBeNull();
  });

  it('applies at once when the event brings the next period with it', () => {
    // A renewal onto the lower plan: the event carries the new window, so the
    // downgrade is due rather than pending.
    const outcome = applyChange(
      subscription({ planCode: 'ads' }),
      change({
        planCode: 'starter',
        occurredAt: APRIL,
        currentPeriodStart: APRIL,
        currentPeriodEnd: at('2026-05-01T00:00:00.000Z'),
      }),
    );
    if (outcome.kind !== 'applied') return;
    expect(outcome.next.planCode).toBe('starter');
    expect(outcome.next.pendingPlanCode).toBeNull();
  });

  it('does not defer a plan this build cannot resolve', () => {
    // We cannot compare what we cannot resolve, and holding a change we do not
    // understand is worse than applying it: the reconciler corrects an
    // application, and cannot correct something parked in a column nobody reads.
    const outcome = applyChange(
      subscription({ planCode: 'ads' }),
      change({ planCode: 'mystery' as PlanCode }),
    );
    if (outcome.kind !== 'applied') return;
    expect(outcome.next.planCode).toBe('mystery');
    expect(outcome.next.pendingPlanCode).toBeNull();
  });

  it('does nothing special when the plan is unchanged', () => {
    const outcome = applyChange(subscription({ planCode: 'growth' }), change({ planCode: 'growth' }));
    if (outcome.kind !== 'applied') return;
    expect(outcome.next.planCode).toBe('growth');
    expect(outcome.next.pendingPlanCode).toBeNull();
  });

  it('leaves the cap at the higher tier until the switch', () => {
    // The merchant paid for growth's 1,500 this cycle. Metering them at
    // starter's 300 the moment they schedule a downgrade would put them over
    // cap for something they still own.
    const scheduled = applyChange(
      subscription({ planCode: 'growth' }),
      change({ planCode: 'starter' }),
    );
    if (scheduled.kind !== 'applied') return;
    expect(resolveEntitlements(scheduled.next, at('2026-03-20T00:00:00.000Z'), false).orderCap).toBe(
      PLANS.growth.orderCap,
    );
    expect(resolveEntitlements(scheduled.next, APRIL, false).orderCap).toBe(PLANS.starter.orderCap);
  });
});
