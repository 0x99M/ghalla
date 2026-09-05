import type { Instant, StoreId, SubscriptionStatus } from '@ghalla/contracts';
import { TRIAL_PLAN, isDowngrade, planOf } from './plans.js';
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
  /**
   * A DOWNGRADE that has been agreed but not yet taken effect.
   *
   * The platform applies upgrades immediately and prorates them, but defers
   * downgrades to the end of the paid cycle — the merchant keeps the higher
   * tier they have already paid for. Recording the intent here rather than
   * applying it is what makes that true on our side: without it, the webhook
   * announcing a downgrade strips features from someone with three more weeks
   * paid for.
   */
  readonly pendingPlanCode: string | null;
  readonly pendingPlanEffectiveAt: Instant | null;
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
 * The row for a store that has none yet.
 *
 * Built from what the source actually said rather than from a default, so a
 * store that installs straight onto a paid plan is not briefly recorded as
 * trialing — a merchant whose first dashboard load says "trial" after they have
 * just paid has already lost some confidence in the numbers.
 *
 * Shared by the webhook handler and the install-time fetch on purpose. Two
 * copies of this would drift, and the drift would show up as "the reconciler
 * says one thing and the install said another" for stores nobody can reproduce.
 *
 * The period end falls back to a placeholder month because a subscription with
 * no window has nothing to meter against, and the CHECK constraint requires
 * `end > start` — a zero-length interval would fail the write outright and
 * leave the store with no row at all.
 */
export function seedSubscription(storeId: StoreId, change: SubscriptionChange): Subscription {
  const start = change.currentPeriodStart ?? change.occurredAt;
  const fallbackEnd = new Date(new Date(start).getTime() + 30 * 86_400_000).toISOString() as Instant;
  return {
    storeId,
    planCode: change.planCode ?? TRIAL_PLAN,
    platformPlanId: change.platformPlanId,
    status: change.status,
    trialEndsAt: change.trialEndsAt,
    currentPeriodStart: start,
    currentPeriodEnd: change.currentPeriodEnd ?? fallbackEnd,
    lastEventAt: change.occurredAt,
    lastReconciledAt: null,
    // A store's FIRST record has no prior plan to have been downgraded from.
    pendingPlanCode: null,
    pendingPlanEffectiveAt: null,
  };
}

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
 * Is this plan change one we must hold until the period ends?
 *
 * Upgrades are immediate and prorated at the platform: the merchant is charged
 * the difference on the spot and expects the features to unlock on the next
 * page load, not at the next monthly anchor. Provisioning those late is the
 * single most visible way to make a paid upgrade feel broken.
 *
 * Downgrades go the other way. The platform does not refund the unused
 * remainder, so the merchant has PAID for the higher tier through to the end of
 * the cycle and must keep it. Applying the lower plan the moment the webhook
 * lands takes away something already bought.
 *
 * An unknown plan on either side is not deferred: we cannot compare what we
 * cannot resolve, and holding a change we do not understand is worse than
 * applying it, because the reconciler will correct an application and cannot
 * correct a thing sitting in a pending column nobody looks at.
 */
function deferUntilPeriodEnd(
  current: Subscription,
  change: SubscriptionChange,
): { readonly defer: boolean; readonly effectiveAt: Instant } {
  // THE PERIOD ALREADY PAID FOR, which is the one on the row — never the one
  // the event proposes. A renewal onto a lower plan arrives carrying the NEXT
  // window, and measuring against that window would find the change "early"
  // forever: the downgrade would be deferred to a boundary that moves every
  // time it is deferred, and the merchant would keep the higher tier for good.
  const paidThrough = current.currentPeriodEnd;
  if (change.planCode === null || change.planCode === current.planCode) {
    return { defer: false, effectiveAt: paidThrough };
  }

  const from = planOf(current.planCode);
  const to = planOf(change.planCode);
  if (from === null || to === null) return { defer: false, effectiveAt: paidThrough };

  // A downgrade arriving at or after the paid period has ended is simply the
  // renewal happening. There is nothing left to defer to.
  const defer = isDowngrade(from, to) && change.occurredAt < paidThrough;
  return { defer, effectiveAt: paidThrough };
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

  const { defer, effectiveAt } = deferUntilPeriodEnd(current, change);

  const next: Subscription = {
    ...current,
    status: change.status,
    // A deferred downgrade leaves the ACTIVE plan alone. An upgrade — or any
    // change we are applying now — also clears whatever was pending, because a
    // merchant who moves up has evidently changed their mind about moving down.
    planCode: defer ? current.planCode : (change.planCode ?? current.planCode),
    pendingPlanCode: defer ? change.planCode : null,
    pendingPlanEffectiveAt: defer ? effectiveAt : null,
    platformPlanId: change.platformPlanId ?? current.platformPlanId,
    trialEndsAt: change.trialEndsAt ?? current.trialEndsAt,
    currentPeriodStart: change.currentPeriodStart ?? current.currentPeriodStart,
    currentPeriodEnd: change.currentPeriodEnd ?? current.currentPeriodEnd,
    lastEventAt: change.occurredAt,
  };

  return { kind: 'applied', next };
}

/**
 * The plan that is in force RIGHT NOW.
 *
 * A pending downgrade becomes the real plan the moment its period ends, and
 * this is computed at read time rather than flipped by a job. A cron that has
 * to run at the exact second a period rolls over is a cron that will one day
 * not run, and the merchant would keep a tier they stopped paying for — or,
 * with the timing reversed, lose one they still own.
 *
 * The row catches up on its own: the renewal webhook carries the new plan, and
 * the reconciler writes it down if that webhook never arrives.
 */
export function effectivePlanCode(subscription: Subscription, now: Instant): string {
  if (subscription.pendingPlanCode === null || subscription.pendingPlanEffectiveAt === null) {
    return subscription.planCode;
  }
  return now >= subscription.pendingPlanEffectiveAt
    ? subscription.pendingPlanCode
    : subscription.planCode;
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
      // A reconciliation reports what the platform charges for TODAY, which is
      // still the higher tier during a deferred downgrade. Clearing the pending
      // change on that basis would cancel a downgrade the merchant asked for.
      pendingPlanCode: current.pendingPlanCode,
      pendingPlanEffectiveAt: current.pendingPlanEffectiveAt,
    },
  };
}
