import { toMinor } from '@ghalla/contracts';
import type { Minor } from '@ghalla/contracts';
import { PLANS } from './plans.js';
import type { PlanCode } from './plans.js';

/**
 * Turning a plan's price into the figure a revenue report adds up.
 *
 * The prices themselves live in `PLANS`, beside the cap and the features,
 * because a plan is one product decision and splitting it across two files is
 * how the two halves drift. What lives here is the arithmetic, which has one
 * trap in it worth naming.
 */

/**
 * A plan's price expressed in halalas PER YEAR — what this subscription bills
 * over twelve months.
 *
 * NOT `annualPriceMinor`. That field is the DISCOUNTED annual form of the tier,
 * ten months' worth; this is what the code in question actually collects. For a
 * monthly plan they differ by exactly the two free months, so using the wrong
 * one understates MRR by a sixth for every monthly subscriber — a mistake that
 * looks like a slow, unexplained decline rather than a bug.
 *
 * Annualising at all is what keeps the arithmetic exact. Dividing each plan by
 * twelve per store rounds once per subscription, and a hundred annual
 * subscribers then accumulate an error nobody can account for. Sum annualised
 * amounts, divide ONCE.
 */
export function annualisedPrice(code: PlanCode): Minor {
  const plan = PLANS[code];
  return toMinor(plan.interval === 'year' ? plan.priceMinor : plan.priceMinor * 12);
}

/** Halalas per year to halalas per month, rounded once. See above. */
export function toMonthlyRate(annualisedMinor: number): number {
  return Math.round(annualisedMinor / 12);
}
