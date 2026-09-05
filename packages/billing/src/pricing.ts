import type { Minor } from '@ghalla/contracts';
import { PLANS } from './plans.js';
import type { PlanCode } from './plans.js';

/**
 * LIST prices, for internal reporting, and for nothing else.
 *
 * `plans.ts` refuses to hold prices, and the reason is good: the platform
 * charges the merchant and is the only place an amount is authoritative, so a
 * second copy would create two numbers that can disagree about what somebody
 * owes. That reason still holds. Nothing bills from this file, nothing shows it
 * to a merchant, and no invoice is ever reconciled against it.
 *
 * What it is for is one internal question — what would these subscriptions bill
 * at list — and the answer has a name, LIST MRR, which has to survive onto the
 * screen. It ignores discounts, coupons, proration, tax and failed collection,
 * so anybody who reads it as revenue is wrong by whatever those add up to.
 *
 * Two mechanisms keep it honest, covering different failures:
 *
 *   - the record is TOTAL over `PlanCode`, so adding a plan without deciding
 *     what it lists at does not compile;
 *   - `null` is a first-class value meaning "not priced", and every consumer
 *     reports the plans it had to leave out rather than quietly dropping them.
 *     That is what catches a plan code read from a database written by a newer
 *     deploy than the one doing the reading — where the alternative is MRR
 *     appearing to fall for no reason.
 */
export const LIST_PRICES = {
  // Awaiting the commercial decision. Until each is filled in, every consumer
  // reports these plans as unpriced and excludes them from the total, which is
  // loudly wrong rather than quietly wrong.
  starter: null,
  growth: null,
  scale: null,
  ads: null,
  starter_annual: null,
  growth_annual: null,
  scale_annual: null,
  ads_annual: null,
} as const satisfies ListPrices;

export type ListPrices = Readonly<Record<PlanCode, Minor | null>>;

/**
 * A plan's list price expressed in halalas PER YEAR.
 *
 * Annualising first is what keeps the arithmetic exact. Dividing each monthly
 * plan by nothing and each annual plan by twelve, per store, rounds once per
 * subscription — and a hundred annual subscribers then accumulate up to fifty
 * halalas of error that nobody can account for. Summing annualised amounts and
 * dividing ONCE at the end rounds once, full stop.
 */
export function annualisedListPrice(code: PlanCode, prices: ListPrices): Minor | null {
  const price = prices[code];
  if (price === null) return null;
  return (PLANS[code].interval === 'year' ? price : price * 12) as Minor;
}

/** Halalas per year to halalas per month, rounded once. See above. */
export function toMonthlyRate(annualisedMinor: number): number {
  return Math.round(annualisedMinor / 12);
}
