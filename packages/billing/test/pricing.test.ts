import { describe, expect, it } from 'vitest';
import { toMinor } from '@ghalla/contracts';
import type { Minor } from '@ghalla/contracts';
import { LIST_PRICES, annualisedListPrice, toMonthlyRate } from '../src/pricing.js';
import { PLANS, PLAN_CODES } from '../src/plans.js';
import type { PlanCode } from '../src/plans.js';
import type { ListPrices } from '../src/pricing.js';

/**
 * List prices exist for ONE internal question — what would these subscriptions
 * bill at list — and nothing charges from them. What these tests pin is the
 * arithmetic and, more importantly, the two mechanisms that stop a plan
 * silently vanishing from the total.
 */

const PRICED = {
  starter: toMinor(9_900),
  growth: toMinor(29_900),
  scale: toMinor(79_900),
  ads: toMinor(149_900),
  starter_annual: toMinor(99_000),
  growth_annual: toMinor(299_000),
  scale_annual: toMinor(799_000),
  ads_annual: toMinor(1_499_000),
} as const satisfies Record<PlanCode, Minor | null> as ListPrices;

describe('LIST_PRICES', () => {
  it('names every plan, so adding one without pricing it does not compile', () => {
    // The type is total over `PlanCode`. This asserts the runtime shape matches,
    // which is what catches a plan added to PLANS and forgotten here.
    expect(Object.keys(LIST_PRICES).sort()).toEqual([...PLAN_CODES].sort());
  });

  it('is unpriced until the commercial decision is made, rather than guessing', () => {
    // Every consumer reports these as excluded, which is loudly wrong. A
    // plausible-looking placeholder would be quietly wrong.
    expect(Object.values(LIST_PRICES).every((price) => price === null)).toBe(true);
  });
});

describe('annualisedListPrice', () => {
  it('multiplies a monthly plan by twelve', () => {
    expect(annualisedListPrice('growth', PRICED)).toBe(29_900 * 12);
  });

  it('takes an annual plan as it stands', () => {
    expect(annualisedListPrice('growth_annual', PRICED)).toBe(299_000);
  });

  it('is null for a plan nobody has priced', () => {
    expect(annualisedListPrice('growth', LIST_PRICES)).toBeNull();
  });

  it('annualises every plan consistently with its own interval', () => {
    for (const code of PLAN_CODES) {
      const expected = PLANS[code].interval === 'year' ? PRICED[code] : (PRICED[code] as number) * 12;
      expect(annualisedListPrice(code, PRICED)).toBe(expected);
    }
  });
});

describe('toMonthlyRate', () => {
  it('divides by twelve and rounds once', () => {
    expect(toMonthlyRate(29_900 * 12)).toBe(29_900);
  });

  it('rounds a figure that does not divide evenly', () => {
    // The point of dividing at the END: rounding here once beats rounding per
    // subscription, where a hundred annual subscribers accumulate an error
    // nobody can account for.
    expect(toMonthlyRate(100)).toBe(8);
    expect(toMonthlyRate(0)).toBe(0);
  });

  it('reaches the same total whichever order the annual plans are summed in', () => {
    const parts = [299_000, 99_000, 799_000];
    const forwards = toMonthlyRate(parts.reduce((sum, n) => sum + n, 0));
    const backwards = toMonthlyRate([...parts].reverse().reduce((sum, n) => sum + n, 0));
    expect(forwards).toBe(backwards);
  });
});
