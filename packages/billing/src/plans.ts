/**
 * Plans live in code, not the database.
 *
 * A plan is a product decision, and it belongs in version control beside the
 * deploy that introduced it — a price change should be a reviewable diff with a
 * blame line, not an UPDATE somebody ran against production at 11pm. It also
 * means adding a tier ships with the code that implements it, rather than
 * needing a migration and a data fix in the right order.
 *
 * The consequence, deliberately accepted: `store_subscription.plan_code` carries
 * NO foreign key and NO CHECK constraint. Constraining it would put the plan
 * list back in the database through the back door, and adding a plan would once
 * again be a migration. A row naming a plan this build has never heard of is
 * therefore possible — a rollback to an older image is the ordinary way — and
 * `planOf` answers `null` for it rather than throwing, so the resolver can
 * degrade instead of the request dying.
 *
 * PRICES ARE NOT HERE. The platform charges the merchant and is the only place
 * an amount is authoritative; duplicating it would create two numbers that can
 * disagree about what somebody owes. What is here is what a plan PERMITS.
 */

/** Every capability the product gates on. `core` is what every paying plan has. */
export const FEATURES = ['core', 'attribution', 'ltv', 'reports'] as const;
export type Feature = (typeof FEATURES)[number];

/** How long one billing period lasts, and therefore what the order cap covers. */
export type BillingInterval = 'month' | 'year';

export interface Plan {
  readonly interval: BillingInterval;
  /**
   * Orders per BILLING PERIOD — so an annual plan's cap covers a year, not a
   * month. `null` is unlimited: NOT zero, and not Infinity.
   */
  readonly orderCap: number | null;
  readonly features: readonly Feature[];
  /** For an annual plan, the monthly plan it is the yearly form of. */
  readonly monthlyEquivalent?: string;
}

/**
 * Two months free on annual.
 *
 * Pay for ten, get twelve. It reduces churn through the fragile first year —
 * the period where a merchant has not yet entered enough cost data to see what
 * the product is actually for — and it pulls cash forward, which matters more
 * to us than the discount costs.
 *
 * The number lives here as documentation of the intent. The actual charge is
 * configured at the platform, because that is where the money moves.
 */
export const MONTHS_FREE_ON_ANNUAL = 2;

/**
 * GRANDFATHERING IS A NAMING RULE, and it is the only thing keeping this honest.
 *
 * When a plan's contents change, add a NEW code. Never edit one in place. A
 * merchant who bought `growth` at 1,500 orders keeps `growth` at 1,500 orders,
 * because their row names that code and this table says what that code means.
 * Editing the entry would silently re-price every existing subscriber, which is
 * both a trust problem and, depending on the direction, a billing dispute.
 *
 * So a repricing looks like `growth_v2` appearing here while `growth` stays
 * exactly as it is. Old codes are never deleted while a single row still names
 * one. Annual is the same rule applied to billing TERM rather than contents:
 * `growth_annual` is its own code, never a flag on `growth`.
 *
 * MONTHLY PLANS ARE DECLARED FIRST, cheapest to dearest. `cheapestPlanWith`
 * depends on that ordering to name an upgrade target, and the test suite asserts
 * it rather than trusting a comment.
 */
export const PLANS = {
  starter: { interval: 'month', orderCap: 300, features: ['core'] },
  growth: { interval: 'month', orderCap: 1_500, features: ['core'] },
  scale: { interval: 'month', orderCap: null, features: ['core'] },
  // Phase 2 tier. Defined now so the gating is built and tested against a real
  // plan rather than retrofitted onto one later; its extra features are not
  // implemented yet, and the guard denying them is correct until they are.
  ads: { interval: 'month', orderCap: null, features: ['core', 'attribution', 'ltv', 'reports'] },

  // Annual. Identical entitlements to their monthly twin, with the cap scaled
  // by twelve so the ALLOWANCE PER MONTH is unchanged — an annual plan buys a
  // longer period, never a smaller rate.
  starter_annual: { interval: 'year', orderCap: 3_600, features: ['core'], monthlyEquivalent: 'starter' },
  growth_annual: { interval: 'year', orderCap: 18_000, features: ['core'], monthlyEquivalent: 'growth' },
  scale_annual: { interval: 'year', orderCap: null, features: ['core'], monthlyEquivalent: 'scale' },
  ads_annual: {
    interval: 'year',
    orderCap: null,
    features: ['core', 'attribution', 'ltv', 'reports'],
    monthlyEquivalent: 'ads',
  },
} as const satisfies Record<string, Plan>;

export type PlanCode = keyof typeof PLANS;

/**
 * The plan a trial runs on.
 *
 * A trial is not a plan of its own: giving it one means every feature check has
 * to special-case it, which is how `if (status === 'trialing')` ends up
 * scattered through the services this design exists to keep clean. A trialing
 * store is on a real plan with real limits, and the only difference is what
 * happens when the trial ends.
 */
export const TRIAL_PLAN: PlanCode = 'growth';

/** 14 days, not 7 — see docs/0008. The number is here because it is a product decision. */
export const TRIAL_DAYS = 14;

export function isPlanCode(code: string): code is PlanCode {
  return Object.prototype.hasOwnProperty.call(PLANS, code);
}

/**
 * The plan, or `null` for a code this build does not know.
 *
 * Null rather than a throw: an unknown code means a row written by a newer
 * deploy than the one serving the request, and a rollback should degrade a
 * merchant to a safe default rather than 500 their dashboard.
 */
export function planOf(code: string): Plan | null {
  return isPlanCode(code) ? PLANS[code] : null;
}

/** Every code, for the reconciler and for tests that must not hard-code the list. */
export const PLAN_CODES: readonly PlanCode[] = Object.keys(PLANS) as PlanCode[];

/**
 * The cap normalised to a MONTHLY rate.
 *
 * Comparing an annual plan's cap against a monthly one directly is
 * apples-to-oranges: 18,000 a year and 1,500 a month are the same allowance,
 * and treating the switch between them as a fifteen-fold change would call a
 * billing-term change an upgrade in one direction and a downgrade in the other.
 */
export function monthlyCapOf(plan: Plan): number | null {
  if (plan.orderCap === null) return null;
  return plan.interval === 'year' ? plan.orderCap / 12 : plan.orderCap;
}

/**
 * Does moving from one plan to another REDUCE what the merchant may do?
 *
 * This is the question that decides whether a plan change applies now or at the
 * end of the paid period, so it is about ENTITLEMENTS and not about price. A
 * merchant switching from monthly to annual on the same tier loses nothing and
 * should get it immediately; a merchant dropping a tier keeps what they have
 * paid for until the cycle ends.
 *
 * Unlimited is treated as the top: going from `null` to any number is a
 * reduction, however large the number.
 */
export function isDowngrade(from: Plan, to: Plan): boolean {
  // Losing any feature is a downgrade regardless of what happens to the cap.
  if (from.features.some((feature) => !to.features.includes(feature))) return true;

  const fromCap = monthlyCapOf(from);
  const toCap = monthlyCapOf(to);
  if (fromCap === null) return toCap !== null;
  if (toCap === null) return false;
  return toCap < fromCap;
}

/**
 * The cheapest plan that includes a feature, for the upgrade prompt.
 *
 * A denial that says only "403" makes the merchant guess what to buy. Naming
 * the tier turns a dead end into a checkout link, which is the entire point of
 * gating a feature rather than hiding it.
 *
 * MONTHLY plans are preferred, and that is a product decision rather than an
 * accident of ordering: a merchant hitting a locked feature is deciding in the
 * moment, and a twelve-month commitment is a bigger ask than the feature is
 * worth to them right then. Annual is something to offer once they have stayed.
 */
export function cheapestPlanWith(feature: Feature): PlanCode | null {
  const carries = (plan: Plan): boolean => plan.features.includes(feature);
  // Widened to `Plan` deliberately. `as const satisfies` gives each entry its
  // own literal feature tuple, which is what makes `PLANS.ads.features` precise
  // at a call site — and what stops a generic `includes` from type-checking
  // here. The widening is at the loop, so the precision survives everywhere
  // else.
  // Monthly only, with no annual fallback. Every annual plan mirrors a monthly
  // one exactly — a property the test suite asserts rather than assumes — so a
  // feature reachable at all is reachable on a monthly plan, and a fallback
  // loop here would be a branch no input can take.
  for (const [code, plan] of Object.entries(PLANS) as readonly [PlanCode, Plan][]) {
    if (plan.interval === 'month' && carries(plan)) return code;
  }
  return null;
}
