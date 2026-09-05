import type { Instant, SubscriptionStatus } from '@ghalla/contracts';
import type { Subscription } from './subscription.js';

/**
 * DEGRADE THE INTERFACE, NEVER THE DATA.
 *
 * This is the whole policy, and every row of the table below follows from it.
 * A gap in the data is permanent: nobody can go back and re-ingest the orders
 * that arrived while a merchant's card was declining, because the platform's
 * history endpoints do not reach back far enough and the profit for those days
 * is simply gone. A locked screen, by contrast, reverses the instant they pay.
 *
 * So the asymmetry is deliberate and it is not generosity — it is the cheaper
 * mistake. Ingesting for a lapsed merchant costs a fraction of a halala per
 * order. Not ingesting costs a hole in their numbers that no payment can fill,
 * and the product IS the numbers.
 */

/** What the merchant may do in the dashboard. */
export type DashboardAccess =
  | 'full'
  /** Everything visible, nothing editable, and an upgrade screen over it. */
  | 'read_only'
  /** Nothing but the export. */
  | 'locked';

/** Whether the pipeline keeps running for this store. */
export type PipelineAccess = 'running' | 'stopped';

export interface AccessDecision {
  readonly dashboard: DashboardAccess;
  readonly ingestion: PipelineAccess;
  readonly profitComputation: PipelineAccess;
  /** Export survives every state, including `canceled`. See below. */
  readonly export: 'available' | 'unavailable';
  /** What the UI should say, as a code the frontend maps to copy. */
  readonly notice: AccessNotice;
}

export type AccessNotice =
  | 'none'
  | 'over_order_cap'
  | 'payment_past_due'
  | 'trial_expired'
  | 'subscription_canceled';

/**
 * Has the trial run out with nothing to follow it?
 *
 * Kept separate from `status` because the platform does not always send a
 * `trial.ended` event, and a row still reading `trialing` a month after its
 * trial ended is a state we will actually see.
 */
export function isTrialExpired(subscription: Subscription, now: Instant): boolean {
  return (
    subscription.status === 'trialing' &&
    subscription.trialEndsAt !== null &&
    now > subscription.trialEndsAt
  );
}

/**
 * `past_due` reads as active EVERYWHERE.
 *
 * Payment retries frequently succeed. Cutting a merchant off over a card that
 * expired on Tuesday, when the bank will authorise it on Thursday, converts a
 * billing hiccup into a churn event — and they will remember the lockout long
 * after the charge goes through.
 */
export function isPaying(status: SubscriptionStatus): boolean {
  return status === 'active' || status === 'past_due' || status === 'trialing';
}

/**
 * The one place any of this is decided.
 *
 * Everything else — the guard, the ingestion worker, the dashboard — reads this
 * result. Scattering `if (status === …)` across services is how gating rots:
 * the checks drift apart, one of them is forgotten on a new endpoint, and the
 * behaviour becomes whatever the accumulated conditionals happen to compute.
 */
export function decideAccess(
  subscription: Subscription,
  now: Instant,
  overOrderCap: boolean,
): AccessDecision {
  // Canceled is the ONLY state that stops the pipeline. The merchant has told
  // us to stop; continuing to ingest their orders after that is no longer a
  // generous default, it is processing data we were asked to stop processing.
  if (subscription.status === 'canceled') {
    return {
      dashboard: 'locked',
      ingestion: 'stopped',
      profitComputation: 'stopped',
      // Still available, for the whole retention window. A merchant who can
      // leave with their data is more likely to come back — and one who cannot
      // will say so publicly.
      export: 'available',
      notice: 'subscription_canceled',
    };
  }

  // Trial over with nothing behind it, or a subscription that lapsed to
  // `expired`. The pipeline KEEPS RUNNING. If they subscribe two weeks later
  // their history is complete and correct, which is a conversion advantage
  // rather than a cost — the alternative is asking someone to pay for a
  // dashboard with a fortnight missing out of the middle of it.
  if (subscription.status === 'expired' || isTrialExpired(subscription, now)) {
    return {
      dashboard: 'read_only',
      ingestion: 'running',
      profitComputation: 'running',
      export: 'available',
      notice: 'trial_expired',
    };
  }

  // Over the cap: the interface degrades, the pipeline does not. A silently
  // incomplete dashboard destroys trust in the numbers, and the numbers are the
  // entire product. Overage compute costs cents; that trust does not come back.
  const notice: AccessNotice = overOrderCap
    ? 'over_order_cap'
    : subscription.status === 'past_due'
      ? 'payment_past_due'
      : 'none';

  return {
    dashboard: 'full',
    ingestion: 'running',
    profitComputation: 'running',
    export: 'available',
    notice,
  };
}
