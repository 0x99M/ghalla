import { isPaying } from '@ghalla/billing';
import type { Instant } from '@ghalla/contracts';
import type { Coverage } from './coverage';
import type { BackfillState } from './ingestion';
import type { SubscriptionRow } from './subscriptions';
import { DAY_MS } from './window';

/**
 * Store health, DERIVED and never stored.
 *
 * A stored flag has to be un-set by something, and the thing that un-sets it is
 * the thing that will not run — so a store that fixed itself keeps its warning
 * and the operator learns to ignore warnings. Computed on read, a store that
 * recovers simply stops appearing.
 *
 * Every function here is pure. The facts are gathered by one query pass and the
 * judgement is a table test, which is the only way rules like "silent for 24
 * hours unless it installed 20 minutes ago" get exercised at their boundaries.
 */

export type HealthFlag =
  /** No webhook in 24 hours from a store that has not left. The strongest early churn signal. */
  | 'silent'
  | 'jobs_failing'
  | 'backfill_stuck'
  | 'coverage_low'
  | 'past_due';

/** Failed webhook events in 24h before a store is called unhealthy for it. */
export const FAILED_JOBS_THRESHOLD = 5;
/** Below 20% of revenue priced, the margins we show are mostly guesses. */
export const COVERAGE_LOW_BPS = 2_000;
/** Above 50%, the numbers are worth looking at — the funnel's threshold. */
export const ACTIVATION_COVERAGE_BPS = 5_000;

export interface StoreFacts {
  readonly storeId: string;
  readonly installedAt: Instant;
  readonly uninstalledAt: Instant | null;
  readonly subscription: SubscriptionRow | null;
  readonly coverage: Coverage | null;
  readonly lastWebhookAt: Instant | null;
  readonly failedJobs: number;
  readonly backfill: BackfillState | null;
  readonly ordersInPeriod: number;
  /**
   * Whether the merchant has ever opened the dashboard.
   *
   * `null` because no integration records it yet — see docs/0009. NOT `false`:
   * a signal nobody is collecting is unknown, and reporting it as "no" would
   * make every store look un-activated and the funnel look broken.
   */
  readonly dashboardSession: boolean | null;
}

function ageMs(from: Instant | null, now: Instant): number | null {
  if (from === null) return null;
  return new Date(now).getTime() - new Date(from).getTime();
}

/**
 * A store that has uninstalled is not unhealthy — it is gone.
 *
 * Without this, every store that ever left keeps alerting as silent for as long
 * as its rows are retained, and the alert list fills with people who are no
 * longer customers until nobody reads it.
 */
export function isLive(facts: StoreFacts): boolean {
  if (facts.uninstalledAt !== null) return false;
  return facts.subscription !== null && isPaying(facts.subscription.status);
}

/**
 * Silence, with the two guards that stop it crying wolf.
 *
 * A store that left is not silent, it is gone. A store that installed an hour
 * ago has not been silent for a day, whatever its webhook count says — and
 * without that guard every new install alerts on its first morning, which is
 * exactly when somebody is watching it.
 *
 * `isPaying` rather than a literal `active`: a TRIALING store that stops
 * sending data is the most important version of this signal, because it has not
 * yet decided to stay.
 */
export function isSilent(facts: StoreFacts, now: Instant): boolean {
  if (!isLive(facts)) return false;
  const sinceInstall = ageMs(facts.installedAt, now);
  if (sinceInstall === null || sinceInstall < DAY_MS) return false;
  const sinceWebhook = ageMs(facts.lastWebhookAt, now);
  return sinceWebhook === null || sinceWebhook >= DAY_MS;
}

/**
 * The stuck backfill itself, or `null`.
 *
 * Returns the state rather than a boolean so a caller that needs to SAY what is
 * stuck does not have to re-read a field it already knows is there — which
 * would be a null check no input can fail, sitting where a reader expects a
 * real one.
 */
export function stuckBackfill(facts: StoreFacts, now: Instant): BackfillState | null {
  const backfill = facts.backfill;
  if (backfill === null || backfill.status === 'complete') return null;
  // Started and not finished after a day. `failed` and `paused` are included on
  // purpose: from the operator's side they are the same situation — the
  // merchant's history is not in, and nothing is bringing it in.
  const age = ageMs(backfill.startedAt, now);
  return age !== null && age >= DAY_MS ? backfill : null;
}

export function isBackfillStuck(facts: StoreFacts, now: Instant): boolean {
  return stuckBackfill(facts, now) !== null;
}

export function isCoverageLow(facts: StoreFacts): boolean {
  const bps = facts.coverage?.coverageBps ?? null;
  // `null` means no revenue in the window, which is not bad coverage — it is no
  // data. Flagging it would put every quiet store on the unhealthy list.
  return bps !== null && bps < COVERAGE_LOW_BPS;
}

export function healthFlags(facts: StoreFacts, now: Instant): readonly HealthFlag[] {
  const flags: HealthFlag[] = [];
  if (isSilent(facts, now)) flags.push('silent');
  if (facts.failedJobs >= FAILED_JOBS_THRESHOLD) flags.push('jobs_failing');
  if (isBackfillStuck(facts, now)) flags.push('backfill_stuck');
  if (isCoverageLow(facts)) flags.push('coverage_low');
  if (facts.subscription?.status === 'past_due') flags.push('past_due');
  return flags;
}

export interface StoreHealth {
  readonly storeId: string;
  readonly flags: readonly HealthFlag[];
  readonly healthy: boolean;
}

export function storeHealth(facts: StoreFacts, now: Instant): StoreHealth {
  const flags = healthFlags(facts, now);
  return { storeId: facts.storeId, flags, healthy: flags.length === 0 };
}

export interface Activation {
  readonly storeId: string;
  readonly backfillComplete: boolean;
  readonly coverageAboveThreshold: boolean;
  readonly dashboardSession: boolean | null;
  /**
   * `null` while any input is unknown.
   *
   * A store that cannot be assessed has not failed to activate, and reporting
   * it as `false` would make the funnel's last step look like a wall when it is
   * really a missing measurement.
   */
  readonly activated: boolean | null;
}

export function activation(facts: StoreFacts): Activation {
  const backfillComplete = facts.backfill?.status === 'complete';
  const bps = facts.coverage?.coverageBps ?? null;
  const coverageAboveThreshold = bps !== null && bps > ACTIVATION_COVERAGE_BPS;
  const dashboardSession = facts.dashboardSession;

  return {
    storeId: facts.storeId,
    backfillComplete,
    coverageAboveThreshold,
    dashboardSession,
    activated:
      dashboardSession === null ? null : backfillComplete && coverageAboveThreshold && dashboardSession,
  };
}
