import type { Instant } from '@ghalla/contracts';
import { PLANS, planOf } from './plans.js';
import type { Feature, Plan } from './plans.js';
import { decideAccess } from './access.js';
import { effectivePlanCode } from './subscription.js';
import type { AccessDecision } from './access.js';
import type { Subscription } from './subscription.js';

/**
 * What this store may do, resolved ONCE per request.
 *
 * The guard puts this on the request context and everything downstream reads
 * it. The alternative — services asking "what plan is this?" wherever they
 * happen to need to know — is how feature gating rots: the checks drift, a new
 * endpoint forgets one, and the real behaviour becomes whatever the accumulated
 * conditionals compute rather than what anyone decided.
 */
export interface Entitlements {
  readonly planCode: string;
  readonly features: readonly Feature[];
  readonly orderCap: number | null;
  readonly access: AccessDecision;
  /**
   * True when the row names a plan this build does not know — a rollback to an
   * image older than the plan. Surfaced rather than swallowed so it can be
   * alerted on: it means merchants are being served by the wrong deploy.
   */
  readonly planUnknown: boolean;
}

/**
 * The safe default for a plan code this build cannot resolve.
 *
 * `core` only, and the smallest cap — deliberately NOT unlimited. Failing open
 * on an unknown plan would make "write a plan code we do not recognise" a way
 * to obtain the top tier. Failing closed on FEATURES while leaving the pipeline
 * alone keeps the blast radius to a locked-looking screen, which is the
 * reversible kind of wrong.
 */
const FALLBACK_PLAN: Plan = PLANS.starter;

export function resolveEntitlements(
  subscription: Subscription,
  now: Instant,
  overOrderCap: boolean,
): Entitlements {
  // The plan IN FORCE, which is not always the one in `plan_code`: a downgrade
  // agreed mid-cycle sits pending until the period the merchant paid for runs
  // out, and takes effect at read time rather than waiting for a job to flip it.
  const code = effectivePlanCode(subscription, now);
  const plan = planOf(code);
  const effective = plan ?? FALLBACK_PLAN;

  return {
    planCode: code,
    features: effective.features,
    orderCap: effective.orderCap,
    access: decideAccess(subscription, now, overOrderCap),
    planUnknown: plan === null,
  };
}

/**
 * Does this plan permit that feature?
 *
 * Note what is NOT consulted here: the subscription's status. A `canceled`
 * store on the `ads` plan still *has* the attribution feature — it simply
 * cannot reach the dashboard at all, which `access.dashboard` already decided.
 * Folding the two questions together is what produces a guard that denies
 * `attribution` to a paying merchant because their card bounced.
 */
export function hasFeature(entitlements: Entitlements, feature: Feature): boolean {
  return entitlements.features.includes(feature);
}
