import { toInstant } from '@ghalla/contracts';
import type { Instant } from '@ghalla/contracts';
import type { AlertFeed } from './alert-feed';
import type { Overview } from './overview';
import type { PaymentQueue } from './payment-queue';

/**
 * The three numbers the sidebar carries, and nothing else.
 *
 * COMPOSED from reports the console already builds rather than queried again.
 * Every figure here has exactly one definition — `overview()` counts stores,
 * `alertFeed()` decides what an alert is, `unknownPaymentMethodQueue()` decides
 * what is in the queue — and re-deriving any of them for a nav badge is how a
 * sidebar ends up disagreeing with the screen it links to.
 */

export interface ConsoleSummary {
  readonly stores: number;
  /** UNACKNOWLEDGED only. An alert an operator has already seen is not a summons. */
  readonly alerts: number;
  readonly queue: number;
  /** True when any input was gathered from an incomplete read. */
  readonly partial: boolean;
  /** The OLDEST of the three captures — see below. */
  readonly capturedAt: Instant;
}

/**
 * The oldest capture wins, not the newest.
 *
 * These three reports are gathered at slightly different moments, and the
 * console shows one "last updated" stamp for all of them. Reporting the newest
 * would claim a freshness the oldest figure does not have, which is the precise
 * way a stale number gets trusted. The oldest is the only honest single answer.
 */
export function oldestCapture(instants: readonly Instant[]): Instant {
  return instants.reduce((oldest, next) => (next < oldest ? next : oldest));
}

export function consoleSummary(
  overview: Overview,
  alerts: AlertFeed,
  queue: PaymentQueue,
): ConsoleSummary {
  return {
    stores: overview.totals.stores,
    alerts: alerts.alerts.filter((alert) => alert.acknowledgedUntil === null).length,
    queue: queue.rows.length,
    partial: overview.partial || alerts.partial || queue.partial,
    capturedAt: oldestCapture([overview.capturedAt, alerts.capturedAt, queue.capturedAt]),
  };
}

/** For the fixture source, which has no reports to fold. */
export function emptyConsoleSummary(now: Date): ConsoleSummary {
  return { stores: 0, alerts: 0, queue: 0, partial: false, capturedAt: toInstant(now.toISOString()) };
}
