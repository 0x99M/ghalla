import type { Instant, StoreId, SubscriptionStatus } from '@ghalla/contracts';
import type { PlanCode } from './plans.js';

/**
 * The local subscription row, as the domain sees it.
 *
 * THE LOCAL TABLE IS THE SOURCE OF TRUTH FOR REQUEST HANDLING. Nothing on a
 * request path may call the platform to ask whether a merchant is entitled:
 * it adds a network round trip to every page load, and it makes a third party's
 * outage into our outage — at the exact moment a merchant is trying to look at
 * the dashboard they are paying for.
 *
 * The platform is consulted on two paths only, both off the request path: a
 * webhook arriving, and the nightly reconciler.
 */
export interface Subscription {
  readonly storeId: StoreId;
  /** Neutral code. `growth`, never the platform's own numeric plan id. */
  readonly planCode: string;
  /** The adapter's mapping target, kept so a plan mismatch is diagnosable. */
  readonly platformPlanId: string | null;
  readonly status: SubscriptionStatus;
  readonly trialEndsAt: Instant | null;
  readonly currentPeriodStart: Instant;
  readonly currentPeriodEnd: Instant;
  /**
   * The occurrence time of the newest event applied. THE ordering guard.
   * Not the time we processed it — that would order by our own queue's
   * behaviour, which is the thing being defended against.
   */
  readonly lastEventAt: Instant | null;
  readonly lastReconciledAt: Instant | null;
}

/** What a billing webhook, once parsed, asks us to change. */
export interface SubscriptionChange {
  readonly status: SubscriptionStatus;
  readonly planCode: PlanCode | null;
  readonly platformPlanId: string | null;
  readonly trialEndsAt: Instant | null;
  readonly currentPeriodStart: Instant | null;
  readonly currentPeriodEnd: Instant | null;
  /** When the change happened AT THE PLATFORM. The ordering key. */
  readonly occurredAt: Instant;
}

/**
 * Two outcomes, and they belong to different functions.
 *
 * A webhook is either applied or refused as stale; a reconciliation either
 * corrects the row or finds nothing to correct. Sharing one union between them
 * gave each caller a case it could never receive — dead code that reads like a
 * possibility somebody considered, and that no test can reach.
 */
export type ApplyOutcome =
  | { readonly kind: 'applied'; readonly next: Subscription }
  | { readonly kind: 'stale'; readonly reason: string };

export type ReconcileOutcome =
  | { readonly kind: 'applied'; readonly next: Subscription }
  | { readonly kind: 'unchanged'; readonly reason: string };

/**
 * Whether an event is older than what we have already applied.
 *
 * Webhooks arrive out of order — this is normal, not exceptional. The failure
 * it prevents is specific and severe: a delayed `subscription.canceled`
 * landing after a `subscription.renewed` locks out a merchant who has just
 * paid, and nothing in the system would notice until they complain.
 *
 * `<=` and not `<`. Two events stamped the same instant cannot be ordered by
 * their timestamps, so applying the second is a coin flip — and one of the two
 * outcomes revokes access. Refusing both is the safe half of the coin, because
 * the nightly reconciler repairs a missed change and nothing repairs a
 * wrongly-revoked one except a support ticket.
 */
export function isStale(current: Subscription, occurredAt: Instant): boolean {
  return current.lastEventAt !== null && occurredAt <= current.lastEventAt;
}

/**
 * Applies a parsed billing change to the row.
 *
 * Pure, and takes no clock: every interesting case here is a boundary, and a
 * function that reads the wall clock cannot be tested at one.
 *
 * A `null` field in the change means "the event did not say", not "clear it".
 * A cancellation notice carries no period dates, and treating its silence as an
 * instruction would wipe the period the usage window is measured against.
 */
export function applyChange(current: Subscription, change: SubscriptionChange): ApplyOutcome {
  if (isStale(current, change.occurredAt)) {
    return {
      kind: 'stale',
      reason:
        `event occurred ${change.occurredAt} at or before the last applied event ` +
        `${String(current.lastEventAt)}`,
    };
  }

  const next: Subscription = {
    ...current,
    status: change.status,
    planCode: change.planCode ?? current.planCode,
    platformPlanId: change.platformPlanId ?? current.platformPlanId,
    trialEndsAt: change.trialEndsAt ?? current.trialEndsAt,
    currentPeriodStart: change.currentPeriodStart ?? current.currentPeriodStart,
    currentPeriodEnd: change.currentPeriodEnd ?? current.currentPeriodEnd,
    lastEventAt: change.occurredAt,
  };

  return { kind: 'applied', next };
}

/**
 * Whether the reconciler's view differs from ours in a way worth writing.
 *
 * `lastEventAt` and `lastReconciledAt` are excluded on purpose: they are our
 * own bookkeeping, they change on every pass, and including them would report a
 * correction every night for every store. The whole value of the correction
 * count as a signal is that it is normally zero — a rising one means the
 * webhook path is broken, and that only reads if the baseline is silence.
 */
export function differsFrom(current: Subscription, truth: SubscriptionChange): boolean {
  return (
    current.status !== truth.status ||
    (truth.planCode !== null && current.planCode !== truth.planCode) ||
    (truth.platformPlanId !== null && current.platformPlanId !== truth.platformPlanId) ||
    (truth.currentPeriodStart !== null && current.currentPeriodStart !== truth.currentPeriodStart) ||
    (truth.currentPeriodEnd !== null && current.currentPeriodEnd !== truth.currentPeriodEnd) ||
    (truth.trialEndsAt !== null && current.trialEndsAt !== truth.trialEndsAt)
  );
}

/**
 * Reconciliation: the platform wins, and the ordering guard does NOT apply.
 *
 * This is the one path that may move state backwards. A webhook is a claim
 * about a moment; a reconciliation is the platform's current answer, and if it
 * disagrees with us then we are wrong regardless of what our newest event said.
 *
 * Which is exactly why webhooks alone are not enough. They get dropped — by a
 * deploy restarting mid-delivery, by a bug in a handler, by the platform
 * itself — and treating them as the sole source of truth guarantees that
 * eventually someone loses access they paid for, or keeps access they
 * cancelled. Both are found by a customer rather than by us.
 */
export function reconcile(current: Subscription, truth: SubscriptionChange, at: Instant): ReconcileOutcome {
  if (!differsFrom(current, truth)) {
    return { kind: 'unchanged', reason: 'platform agrees with the local row' };
  }
  return {
    kind: 'applied',
    next: {
      ...current,
      status: truth.status,
      planCode: truth.planCode ?? current.planCode,
      platformPlanId: truth.platformPlanId ?? current.platformPlanId,
      trialEndsAt: truth.trialEndsAt ?? current.trialEndsAt,
      currentPeriodStart: truth.currentPeriodStart ?? current.currentPeriodStart,
      currentPeriodEnd: truth.currentPeriodEnd ?? current.currentPeriodEnd,
      // Deliberately NOT advanced. `lastEventAt` orders WEBHOOKS against each
      // other; stamping it here would make a reconciliation silently discard
      // the next genuine webhook older than this pass.
      lastReconciledAt: at,
    },
  };
}
