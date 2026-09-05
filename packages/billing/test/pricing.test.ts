import { describe, expect, it } from 'vitest';
import { annualisedPrice, toMonthlyRate } from '../src/pricing.js';
import {
  MONTHS_FREE_ON_ANNUAL,
  PLANS,
  PLAN_CODES,
  PURCHASABLE_PLAN_CODES,
  annualPriceOf,
  cheapestPlanWith,
  priceOf,
} from '../src/plans.js';

describe('the price table', () => {
  it('prices every plan, so adding one without deciding what it costs does not compile', () => {
    for (const code of PLAN_CODES) {
      expect(Number.isSafeInteger(PLANS[code].priceMinor)).toBe(true);
      expect(PLANS[code].priceMinor).toBeGreaterThan(0);
    }
  });

  it('gives annual exactly two months free', () => {
    // The discount is a constant, not a coincidence in four numbers. If
    // somebody changes a monthly price and forgets the annual one, this fails.
    // Stated over the MONTHLY tiers: on an annual code the two fields are the
    // same number by definition, which the next test pins separately.
    for (const tier of ['starter', 'growth', 'scale', 'ads'] as const) {
      expect(PLANS[tier].annualPriceMinor).toBe(PLANS[tier].priceMinor * (12 - MONTHS_FREE_ON_ANNUAL));
    }
  });

  it('bills an annual code exactly what its monthly twin says the annual form costs', () => {
    // Two places hold the same number, so the redundancy is asserted rather
    // than hoped for.
    for (const tier of ['starter', 'growth', 'scale', 'ads'] as const) {
      expect(PLANS[`${tier}_annual`].priceMinor).toBe(PLANS[tier].annualPriceMinor);
      expect(PLANS[`${tier}_annual`].annualPriceMinor).toBe(PLANS[tier].annualPriceMinor);
    }
  });

  it('holds the agreed figures, in halalas, excluding VAT', () => {
    expect(PLANS.starter.priceMinor).toBe(12_900);
    expect(PLANS.growth.priceMinor).toBe(24_900);
    expect(PLANS.scale.priceMinor).toBe(44_900);
    expect(PLANS.ads.priceMinor).toBe(64_900);
    expect(PLANS.growth_annual.priceMinor).toBe(249_000);
  });

  it('brands a price through the checked constructor', () => {
    expect(priceOf('growth')).toBe(24_900);
    expect(annualPriceOf('growth')).toBe(249_000);
  });
});

describe('purchasability', () => {
  it('keeps the unreleased tier out of the sellable list', () => {
    // `ads` gates four features and three do not exist. It is defined so the
    // gating is built and tested against a real plan, not so it can be sold.
    expect(PLANS.ads.purchasable).toBe(false);
    expect(PLANS.ads_annual.purchasable).toBe(false);
    expect([...PURCHASABLE_PLAN_CODES].sort()).toEqual([
      'growth',
      'growth_annual',
      'scale',
      'scale_annual',
      'starter',
      'starter_annual',
    ]);
  });

  it('NEVER OFFERS AN UNPURCHASABLE PLAN AS AN UPGRADE', () => {
    // Naming a tier nobody can buy turns a dead end into a worse one: the
    // merchant clicks through to a checkout that does not exist. `null` is the
    // honest answer for a feature that is not built.
    for (const feature of ['attribution', 'ltv', 'reports'] as const) {
      expect(cheapestPlanWith(feature)).toBeNull();
    }
    expect(cheapestPlanWith('core')).toBe('starter');
  });
});

describe('annualisedPrice', () => {
  it('multiplies a monthly plan by twelve — NOT by ten', () => {
    // The trap this function exists to avoid. `annualPriceMinor` is the
    // discounted annual FORM of the tier; a monthly subscriber pays twelve
    // monthly charges, and using the discount understates MRR by a sixth.
    expect(annualisedPrice('growth')).toBe(24_900 * 12);
    expect(annualisedPrice('growth')).not.toBe(PLANS.growth.annualPriceMinor);
  });

  it('takes an annual plan as it stands', () => {
    expect(annualisedPrice('growth_annual')).toBe(249_000);
  });

  it('annualises every plan consistently with its own interval', () => {
    for (const code of PLAN_CODES) {
      const expected =
        PLANS[code].interval === 'year' ? PLANS[code].priceMinor : PLANS[code].priceMinor * 12;
      expect(annualisedPrice(code)).toBe(expected);
    }
  });

  it('makes an annual subscriber cheaper per year than a monthly one on the same tier', () => {
    expect(annualisedPrice('growth_annual')).toBeLessThan(annualisedPrice('growth'));
  });
});

describe('toMonthlyRate', () => {
  it('divides by twelve and rounds once', () => {
    expect(toMonthlyRate(24_900 * 12)).toBe(24_900);
    expect(toMonthlyRate(0)).toBe(0);
  });

  it('rounds a figure that does not divide evenly', () => {
    // The point of dividing at the END: rounding here once beats rounding per
    // subscription, where a hundred annual subscribers accumulate an error
    // nobody can account for.
    expect(toMonthlyRate(100)).toBe(8);
  });

  it('reaches the same total whichever order the parts are summed in', () => {
    const parts = [249_000, 129_000, 449_000];
    const forwards = toMonthlyRate(parts.reduce((sum, n) => sum + n, 0));
    const backwards = toMonthlyRate([...parts].reverse().reduce((sum, n) => sum + n, 0));
    expect(forwards).toBe(backwards);
  });
});
