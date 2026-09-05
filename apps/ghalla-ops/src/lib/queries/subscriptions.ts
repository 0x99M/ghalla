import { inArray } from 'drizzle-orm';
import { SUBSCRIPTION_STATUSES, toMinor } from '@ghalla/contracts';
import type { Instant, Minor, SubscriptionStatus } from '@ghalla/contracts';
import { storeSubscription } from '@ghalla/persistence/schema';
import { toInstantFromDateOrNull } from '@ghalla/persistence/codec';
import {
  LIST_PRICES,
  annualisedListPrice,
  effectivePlanCode,
  isBilled,
  isPlanCode,
  toMonthlyRate,
} from '@ghalla/billing';
import type { ListPrices, PlanState } from '@ghalla/billing';
import type { ReadOnlyDatabase } from '../platforms/read-only';

/**
 * Subscription state, and the money that follows from it.
 *
 * Everything here goes through `@ghalla/billing` rather than reimplementing a
 * rule in SQL. That is not tidiness: the merchant's own dashboard reads those
 * functions, and a second implementation here would eventually disagree with it
 * about which plan somebody is on — at which point support is looking at one
 * number and the merchant at another.
 */

/**
 * The statuses that produce revenue, derived from the canonical predicate
 * rather than typed out again. Adding a status to the domain and forgetting it
 * here becomes impossible.
 */
export const BILLED_STATUSES: readonly SubscriptionStatus[] = SUBSCRIPTION_STATUSES.filter(isBilled);

export interface StatusCounts {
  readonly active: number;
  readonly trialing: number;
  readonly pastDue: number;
  readonly canceled: number;
  readonly expired: number;
  /**
   * SUBSCRIPTION ROWS, which is not the store count and must never be labelled
   * as one.
   *
   * The two genuinely differ in both directions: a store between its install
   * webhook and its first billing webhook has no row here at all, and a store
   * that uninstalled still has one. This field was called `total` and rendered
   * as "N stores", which is precisely the two-screens-disagreeing failure the
   * query layer exists to prevent — the store list counts `stores`.
   */
  readonly subscriptions: number;
}

export async function statusCounts(db: ReadOnlyDatabase): Promise<StatusCounts> {
  const rows = await db.select({ status: storeSubscription.status }).from(storeSubscription);
  const tally = new Map<string, number>();
  for (const row of rows) tally.set(row.status, (tally.get(row.status) ?? 0) + 1);
  const of = (status: SubscriptionStatus): number => tally.get(status) ?? 0;

  return {
    active: of('active'),
    trialing: of('trialing'),
    pastDue: of('past_due'),
    canceled: of('canceled'),
    expired: of('expired'),
    subscriptions: rows.length,
  };
}

export interface PlanRevenue {
  readonly planCode: string;
  readonly stores: number;
  readonly listMrrMinor: Minor;
}

export interface MrrBreakdown {
  /**
   * LIST MRR — see `@ghalla/billing/pricing`. What these subscriptions would
   * bill at list price, ignoring discounts, proration, tax and collection. It
   * is not revenue and must not be labelled as revenue.
   */
  readonly listMrrMinor: Minor;
  /**
   * The same total ANNUALISED — list ARR, and the number a cross-platform merge
   * must add up.
   *
   * Summing per-platform MRR would round once per platform, which is the same
   * mistake as rounding once per store, one level up. It is a few halalas
   * rather than a few riyals, and it is still avoidable for the cost of
   * returning the figure that was going to be divided anyway.
   */
  readonly listArrMinor: Minor;
  readonly billedStores: number;
  readonly byPlan: readonly PlanRevenue[];
  /**
   * Subscriptions excluded from the total because this build cannot price their
   * plan — either the price is not set yet, or a newer deploy wrote a plan code
   * this one has never heard of. Reported rather than swallowed: the
   * alternative is MRR appearing to fall for no reason anybody can find.
   */
  readonly unpricedPlans: readonly { readonly planCode: string; readonly stores: number }[];
}

export async function mrr(
  db: ReadOnlyDatabase,
  at: Instant,
  prices: ListPrices = LIST_PRICES,
): Promise<MrrBreakdown> {
  const rows = await db
    .select({
      planCode: storeSubscription.planCode,
      pendingPlanCode: storeSubscription.pendingPlanCode,
      pendingPlanEffectiveAt: storeSubscription.pendingPlanEffectiveAt,
    })
    .from(storeSubscription)
    // Trialing excluded. A trial has access and owes nothing, and counting one
    // makes every free signup look like growth — then makes the number turn
    // down a fortnight later for no commercial reason.
    .where(inArray(storeSubscription.status, [...BILLED_STATUSES]));

  // Annualised halalas per plan, summed before any division. Dividing per store
  // would round once per subscription, and a hundred annual subscribers would
  // then accumulate an error nobody can account for.
  const byPlanCode = new Map<string, { stores: number; annualised: number }>();
  const unpricedByPlan = new Map<string, number>();

  for (const row of rows) {
    const state: PlanState = {
      planCode: row.planCode,
      pendingPlanCode: row.pendingPlanCode,
      pendingPlanEffectiveAt: toInstantFromDateOrNull(row.pendingPlanEffectiveAt),
    };
    // The plan IN FORCE. An agreed downgrade still bills at the tier the
    // merchant paid for until the period they paid for runs out.
    const code = effectivePlanCode(state, at);
    const annualised = isPlanCode(code) ? annualisedListPrice(code, prices) : null;

    if (annualised === null) {
      unpricedByPlan.set(code, (unpricedByPlan.get(code) ?? 0) + 1);
      continue;
    }
    // One entry per plan holding both figures, rather than two maps keyed the
    // same way — the second lookup was a branch that could never miss.
    const entry = byPlanCode.get(code) ?? { stores: 0, annualised: 0 };
    entry.stores += 1;
    entry.annualised += annualised;
    byPlanCode.set(code, entry);
  }

  const byPlan: PlanRevenue[] = [...byPlanCode.entries()]
    .map(([planCode, entry]) => ({
      planCode,
      stores: entry.stores,
      listMrrMinor: toMinor(toMonthlyRate(entry.annualised)),
    }))
    .sort((a, b) => b.listMrrMinor - a.listMrrMinor);

  const totalAnnualised = [...byPlanCode.values()].reduce((sum, entry) => sum + entry.annualised, 0);

  return {
    // Divided ONCE, over the whole total, for the reason above. This is why it
    // is not simply the sum of `byPlan` — the per-plan figures each round.
    listMrrMinor: toMinor(toMonthlyRate(totalAnnualised)),
    listArrMinor: toMinor(totalAnnualised),
    billedStores: rows.length,
    byPlan,
    unpricedPlans: [...unpricedByPlan.entries()]
      .map(([planCode, stores]) => ({ planCode, stores }))
      .sort((a, b) => b.stores - a.stores),
  };
}

export interface SubscriptionRow {
  readonly storeId: string;
  readonly planCode: string;
  readonly effectivePlanCode: string;
  readonly status: SubscriptionStatus;
  readonly currentPeriodStart: Instant;
  readonly currentPeriodEnd: Instant;
  readonly trialEndsAt: Instant | null;
  readonly lastReconciledAt: Instant | null;
  readonly pendingPlanCode: string | null;
}

/** Every subscription, for the store list and the health derivation. */
export async function subscriptionsByStore(
  db: ReadOnlyDatabase,
  at: Instant,
): Promise<Map<string, SubscriptionRow>> {
  const rows = await db
    .select({
      storeId: storeSubscription.storeId,
      planCode: storeSubscription.planCode,
      status: storeSubscription.status,
      currentPeriodStart: storeSubscription.currentPeriodStart,
      currentPeriodEnd: storeSubscription.currentPeriodEnd,
      trialEndsAt: storeSubscription.trialEndsAt,
      lastReconciledAt: storeSubscription.lastReconciledAt,
      pendingPlanCode: storeSubscription.pendingPlanCode,
      pendingPlanEffectiveAt: storeSubscription.pendingPlanEffectiveAt,
    })
    .from(storeSubscription);

  const byStore = new Map<string, SubscriptionRow>();
  for (const row of rows) {
    const pendingPlanEffectiveAt = toInstantFromDateOrNull(row.pendingPlanEffectiveAt);
    byStore.set(row.storeId, {
      storeId: row.storeId,
      planCode: row.planCode,
      effectivePlanCode: effectivePlanCode(
        { planCode: row.planCode, pendingPlanCode: row.pendingPlanCode, pendingPlanEffectiveAt },
        at,
      ),
      status: row.status as SubscriptionStatus,
      currentPeriodStart: toInstantFromDateOrNull(row.currentPeriodStart) as Instant,
      currentPeriodEnd: toInstantFromDateOrNull(row.currentPeriodEnd) as Instant,
      trialEndsAt: toInstantFromDateOrNull(row.trialEndsAt),
      lastReconciledAt: toInstantFromDateOrNull(row.lastReconciledAt),
      pendingPlanCode: row.pendingPlanCode,
    });
  }
  return byStore;
}
