import type { BillingInterval, Minor } from '@ghalla/contracts';
import { PLANS, PLAN_CODES, PURCHASABLE_PLAN_CODES, isPlanCode } from './plans.js';
import type { PlanCode } from './plans.js';

/**
 * Comparing the plan table in this file against the one at the platform.
 *
 * `plans.ts` holds prices, which is only defensible because of this check. The
 * two tables are separate systems edited by different people at different
 * times: ours in a reviewed diff, theirs in a partner portal. When they drift,
 * BOTH SIDES STAY INTERNALLY CONSISTENT and neither notices — the platform
 * charges 249 and the code grants the tier it thinks 199 buys, or a plan is
 * published that nothing here can map and the merchant who buys it lands on the
 * unknown-plan fallback. The merchant finds out; we do not.
 *
 * So it is asserted, not assumed. Pure and total, so every disagreement is a
 * table test rather than something discovered against a live partner account.
 *
 * The comparison is a LIST rather than a first failure. A catalog can be wrong
 * in several ways at once and fixing them one deploy at a time is how a
 * fifteen-minute correction becomes an afternoon.
 */

/** One plan as the platform has it configured, reduced to what is comparable. */
export interface PlanListing {
  readonly platformPlanId: string;
  /** The adapter's mapping to our neutral code. `null` when it cannot map this one. */
  readonly planCode: string | null;
  readonly priceMinor: Minor;
  readonly interval: BillingInterval;
}

export type CatalogMismatch =
  /** We sell it; the platform has never heard of it. Nobody can buy it. */
  | { readonly kind: 'missing_remotely'; readonly planCode: PlanCode }
  /** The platform publishes it; the adapter cannot say what it is. */
  | { readonly kind: 'unmapped_remote_plan'; readonly platformPlanId: string }
  /** The platform publishes a code no build here recognises. */
  | { readonly kind: 'unknown_plan_code'; readonly platformPlanId: string; readonly planCode: string }
  /** THE expensive one: the merchant is charged one number and granted another. */
  | {
      readonly kind: 'price_differs';
      readonly planCode: PlanCode;
      readonly localMinor: number;
      readonly remoteMinor: number;
    }
  | {
      readonly kind: 'interval_differs';
      readonly planCode: PlanCode;
      readonly local: BillingInterval;
      readonly remote: BillingInterval;
    }
  /** A plan that is not for sale yet, on sale. */
  | { readonly kind: 'unpurchasable_plan_listed'; readonly planCode: PlanCode; readonly platformPlanId: string }
  /** Two platform plans claiming one code — two prices for the "same" tier. */
  | {
      readonly kind: 'duplicate_mapping';
      readonly planCode: PlanCode;
      readonly platformPlanIds: readonly string[];
    };

export type CatalogVerdict =
  | { readonly kind: 'ok'; readonly plansChecked: number }
  | { readonly kind: 'mismatch'; readonly mismatches: readonly CatalogMismatch[] };

/**
 * Every way the two tables can disagree, in one pass.
 *
 * What is deliberately NOT checked: currency. A platform reports the price in
 * the merchant's presentment currency and this table is in halalas; comparing
 * them would either be a currency conversion in a consistency check or a rule
 * that breaks the first time a plan is published in a second market. The number
 * this compares is the one both sides agree is the plan's price.
 */
export function comparePlanCatalog(remote: readonly PlanListing[]): CatalogVerdict {
  const mismatches: CatalogMismatch[] = [];
  const byCode = new Map<PlanCode, PlanListing[]>();

  for (const listing of remote) {
    if (listing.planCode === null) {
      mismatches.push({ kind: 'unmapped_remote_plan', platformPlanId: listing.platformPlanId });
      continue;
    }
    if (!isPlanCode(listing.planCode)) {
      mismatches.push({
        kind: 'unknown_plan_code',
        platformPlanId: listing.platformPlanId,
        planCode: listing.planCode,
      });
      continue;
    }
    const existing = byCode.get(listing.planCode);
    if (existing === undefined) byCode.set(listing.planCode, [listing]);
    else existing.push(listing);
  }

  for (const [code, listings] of byCode) {
    if (listings.length > 1) {
      // Reported and then still compared: two plans at one code is a problem in
      // its own right, and the prices behind it are worth naming too.
      mismatches.push({
        kind: 'duplicate_mapping',
        planCode: code,
        platformPlanIds: listings.map((l) => l.platformPlanId),
      });
    }

    const plan = PLANS[code];
    for (const listing of listings) {
      if (!plan.purchasable) {
        mismatches.push({
          kind: 'unpurchasable_plan_listed',
          planCode: code,
          platformPlanId: listing.platformPlanId,
        });
      }
      if (listing.priceMinor !== plan.priceMinor) {
        mismatches.push({
          kind: 'price_differs',
          planCode: code,
          localMinor: plan.priceMinor,
          remoteMinor: listing.priceMinor,
        });
      }
      if (listing.interval !== plan.interval) {
        mismatches.push({
          kind: 'interval_differs',
          planCode: code,
          local: plan.interval,
          remote: listing.interval,
        });
      }
    }
  }

  for (const code of PURCHASABLE_PLAN_CODES) {
    if (!byCode.has(code)) mismatches.push({ kind: 'missing_remotely', planCode: code });
  }

  return mismatches.length === 0
    ? { kind: 'ok', plansChecked: PURCHASABLE_PLAN_CODES.length }
    : { kind: 'mismatch', mismatches };
}

/** One sentence per mismatch, for the log line and the health body. */
export function describeMismatch(mismatch: CatalogMismatch): string {
  switch (mismatch.kind) {
    case 'missing_remotely':
      return `"${mismatch.planCode}" is sellable here but the platform has no plan mapped to it`;
    case 'unmapped_remote_plan':
      return `platform plan "${mismatch.platformPlanId}" is published but the adapter cannot map it`;
    case 'unknown_plan_code':
      return `platform plan "${mismatch.platformPlanId}" maps to "${mismatch.planCode}", which this build does not know`;
    case 'price_differs':
      return `"${mismatch.planCode}" is ${String(mismatch.localMinor)} here and ${String(mismatch.remoteMinor)} at the platform`;
    case 'interval_differs':
      return `"${mismatch.planCode}" bills per ${mismatch.local} here and per ${mismatch.remote} at the platform`;
    case 'unpurchasable_plan_listed':
      return `"${mismatch.planCode}" is not for sale yet but is published as "${mismatch.platformPlanId}"`;
    case 'duplicate_mapping':
      return `"${mismatch.planCode}" is claimed by ${String(mismatch.platformPlanIds.length)} platform plans: ${mismatch.platformPlanIds.join(', ')}`;
  }
}

/** Every plan code, for a reconciler or a test that must not hard-code the list. */
export const ALL_PLAN_CODES = PLAN_CODES;
