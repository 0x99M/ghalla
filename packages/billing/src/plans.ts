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
 */

/** Every capability the product gates on. `core` is what every paying plan has. */
export const FEATURES = ['core', 'attribution', 'ltv', 'reports'] as const;
export type Feature = (typeof FEATURES)[number];

export interface Plan {
  /** Orders per billing period. `null` is unlimited — NOT zero, and not Infinity. */
  readonly orderCap: number | null;
  readonly features: readonly Feature[];
}

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
 * one.
 */
export const PLANS = {
  starter: { orderCap: 300, features: ['core'] },
  growth: { orderCap: 1_500, features: ['core'] },
  scale: { orderCap: null, features: ['core'] },
  // Phase 2 tier. Defined now so the gating is built and tested against a real
  // plan rather than retrofitted onto one later; its extra features are not
  // implemented yet, and the guard denying them is the correct behaviour until
  // they are.
  ads: { orderCap: null, features: ['core', 'attribution', 'ltv', 'reports'] },
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
