import { describe, expect, it } from 'vitest';
import { toMinor } from '@ghalla/contracts';
import { comparePlanCatalog, describeMismatch } from '../src/plan-catalog.js';
import type { PlanListing } from '../src/plan-catalog.js';
import { PLANS, PURCHASABLE_PLAN_CODES } from '../src/plans.js';
import type { PlanCode } from '../src/plans.js';

/**
 * The check that makes holding prices in code defensible.
 *
 * Its whole job is to notice that two independently-consistent systems have
 * stopped agreeing, so every one of these cases is a way that happens in
 * practice: somebody edits a price in the partner portal, publishes a plan the
 * adapter has no mapping for, publishes the unreleased tier, or duplicates one.
 */

/** The catalog a correctly-configured partner account would report. */
const correct = (): PlanListing[] =>
  PURCHASABLE_PLAN_CODES.map((code) => ({
    platformPlanId: `plat_${code}`,
    planCode: code,
    priceMinor: toMinor(PLANS[code].priceMinor),
    interval: PLANS[code].interval,
  }));

const kinds = (listings: readonly PlanListing[]): readonly string[] => {
  const verdict = comparePlanCatalog(listings);
  return verdict.kind === 'ok' ? [] : verdict.mismatches.map((m) => m.kind);
};

describe('comparePlanCatalog', () => {
  it('agrees with a correctly configured platform', () => {
    const verdict = comparePlanCatalog(correct());
    expect(verdict).toEqual({ kind: 'ok', plansChecked: PURCHASABLE_PLAN_CODES.length });
  });

  it('CATCHES A PRICE EDITED AT THE PLATFORM', () => {
    // The expensive one. Both sides stay internally consistent: the platform
    // charges its number and the code grants the tier it thinks its own number
    // buys. The merchant is the only party who sees both.
    const listings = correct();
    listings[0] = { ...listings[0]!, priceMinor: toMinor(19_900) };

    const verdict = comparePlanCatalog(listings);
    expect(verdict.kind).toBe('mismatch');
    if (verdict.kind !== 'mismatch') return;
    expect(verdict.mismatches[0]).toEqual({
      kind: 'price_differs',
      planCode: 'starter',
      localMinor: 12_900,
      remoteMinor: 19_900,
    });
  });

  it('catches a plan we sell that the platform has never heard of', () => {
    expect(kinds(correct().filter((l) => l.planCode !== 'growth'))).toEqual(['missing_remotely']);
  });

  it('catches a published plan the adapter cannot map', () => {
    // Not a guess. A plan the adapter cannot name is one a merchant can buy and
    // land on the unknown-plan fallback with.
    const listings = [...correct(), { platformPlanId: 'plat_new', planCode: null, priceMinor: toMinor(1), interval: 'month' as const }];
    expect(kinds(listings)).toEqual(['unmapped_remote_plan']);
  });

  it('catches a published plan naming a code this build does not know', () => {
    const listings = [...correct(), { platformPlanId: 'plat_v2', planCode: 'growth_v2', priceMinor: toMinor(1), interval: 'month' as const }];
    expect(kinds(listings)).toEqual(['unknown_plan_code']);
  });

  it('CATCHES THE UNRELEASED TIER BEING PUT ON SALE', () => {
    // `ads` gates four features, three of which do not exist. A merchant who
    // bought it would be paying for four and receiving one.
    const listings = [
      ...correct(),
      { platformPlanId: 'plat_ads', planCode: 'ads' as PlanCode, priceMinor: toMinor(PLANS.ads.priceMinor), interval: 'month' as const },
    ];
    const verdict = comparePlanCatalog(listings);
    expect(verdict.kind).toBe('mismatch');
    if (verdict.kind !== 'mismatch') return;
    expect(verdict.mismatches).toEqual([
      { kind: 'unpurchasable_plan_listed', planCode: 'ads', platformPlanId: 'plat_ads' },
    ]);
  });

  it('catches two platform plans claiming one code', () => {
    // Two prices for the "same" tier, and which one a merchant pays depends on
    // which link they clicked.
    const listings = [
      ...correct(),
      { platformPlanId: 'plat_growth_old', planCode: 'growth' as PlanCode, priceMinor: toMinor(19_900), interval: 'month' as const },
    ];
    expect(kinds(listings)).toContain('duplicate_mapping');
    expect(kinds(listings)).toContain('price_differs');
  });

  it('catches an interval changed underneath us', () => {
    const listings = correct();
    listings[0] = { ...listings[0]!, interval: 'year' };
    expect(kinds(listings)).toContain('interval_differs');
  });

  it('REPORTS EVERY DISAGREEMENT, not the first', () => {
    // Fixing a catalog one deploy at a time turns a fifteen-minute correction
    // into an afternoon.
    const listings = correct().filter((l) => l.planCode !== 'scale');
    listings[0] = { ...listings[0]!, priceMinor: toMinor(1) };
    listings.push({ platformPlanId: 'plat_x', planCode: null, priceMinor: toMinor(1), interval: 'month' });

    const found = kinds(listings);
    expect(found).toContain('price_differs');
    expect(found).toContain('missing_remotely');
    expect(found).toContain('unmapped_remote_plan');
  });

  it('treats an empty catalog as every sellable plan missing', () => {
    // What an unconfigured partner account looks like, and it must not read as
    // "nothing wrong".
    expect(kinds([])).toEqual(PURCHASABLE_PLAN_CODES.map(() => 'missing_remotely'));
  });
});

describe('describeMismatch', () => {
  it('gives one readable sentence for every kind', () => {
    const samples = [
      { kind: 'missing_remotely', planCode: 'growth' },
      { kind: 'unmapped_remote_plan', platformPlanId: 'plat_x' },
      { kind: 'unknown_plan_code', platformPlanId: 'plat_x', planCode: 'growth_v2' },
      { kind: 'price_differs', planCode: 'growth', localMinor: 24_900, remoteMinor: 19_900 },
      { kind: 'interval_differs', planCode: 'growth', local: 'month', remote: 'year' },
      { kind: 'unpurchasable_plan_listed', planCode: 'ads', platformPlanId: 'plat_ads' },
      { kind: 'duplicate_mapping', planCode: 'growth', platformPlanIds: ['a', 'b'] },
    ] as const;

    for (const sample of samples) {
      const sentence = describeMismatch(sample);
      expect(sentence.length).toBeGreaterThan(10);
      expect(sentence).not.toContain('undefined');
    }
  });
});
