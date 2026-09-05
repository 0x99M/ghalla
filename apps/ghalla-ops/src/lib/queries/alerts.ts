import type { Instant, PlatformId } from '@ghalla/contracts';
import { isSilent, stuckBackfill } from './store-health';
import type { StoreFacts } from './store-health';
import { DAY_MS } from './window';

/**
 * Alerts are a QUERY, not rows.
 *
 * Nothing writes an alert down. A stored alert has to be deleted by something
 * when the problem goes away, and the thing that deletes it is the thing that
 * will not run — so the list fills with problems that fixed themselves months
 * ago and stops being read. Computed from current state, a store that recovers
 * simply stops appearing.
 *
 * What IS stored is the operator saying "I have seen this", keyed by a stable
 * `alert_key` so it survives recomputation. Acknowledgements expire after 24
 * hours, at READ TIME, from `acknowledged_at` — a sweeper that expires them is
 * a job that can fail to run, and its failure mode is an alert that stays
 * silenced.
 */

export const ALERT_KINDS = [
  'silent_store',
  'stuck_backfill',
  'failed_jobs',
  'past_due',
  'platform_unreachable',
] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];

/**
 * The three the brief asks for that cannot be computed yet, and why — reported
 * to the caller rather than quietly missing from the list.
 *
 * An alert type that silently produces nothing is indistinguishable from one
 * that found nothing wrong, and those are opposite situations. The same
 * argument as the unbound subscription source in docs/0008.
 */
export const UNAVAILABLE_ALERTS = {
  coverage_drop: 'needs week-over-week history; lands with the snapshot job',
  signature_failures: 'the integration verifies before it persists, so a rejected delivery is never recorded',
  reconciliation_spike: 'the integration counts corrections as a metric, not as rows the portal can read',
} as const;

export interface Alert {
  /** Stable across recomputation. `silent_store:<platform>:<store id>`. */
  readonly key: string;
  readonly kind: AlertKind;
  readonly platform: PlatformId;
  readonly storeId: string | null;
  readonly detail: string;
  /** Set when an operator has acknowledged it and the acknowledgement has not expired. */
  readonly acknowledgedUntil: Instant | null;
}

export function alertKey(kind: AlertKind, platform: string, storeId: string | null): string {
  return storeId === null ? `${kind}:${platform}` : `${kind}:${platform}:${storeId}`;
}

/** How long an acknowledgement silences an alert. A persisting problem resurfaces. */
export const ACK_TTL_MS = DAY_MS;

function raise(
  kind: AlertKind,
  platform: PlatformId,
  storeId: string | null,
  detail: string,
): Alert {
  return { key: alertKey(kind, platform, storeId), kind, platform, storeId, detail, acknowledgedUntil: null };
}

export function storeAlerts(platform: PlatformId, facts: StoreFacts, now: Instant): readonly Alert[] {
  const alerts: Alert[] = [];

  if (isSilent(facts, now)) {
    alerts.push(
      raise(
        'silent_store',
        platform,
        facts.storeId,
        facts.lastWebhookAt === null
          ? 'no webhook has ever arrived from this store'
          : `no webhook since ${facts.lastWebhookAt}`,
      ),
    );
  }

  const stuck = stuckBackfill(facts, now);
  if (stuck !== null) {
    alerts.push(
      raise(
        'stuck_backfill',
        platform,
        facts.storeId,
        `order backfill is "${stuck.status}" and has not completed`,
      ),
    );
  }

  if (facts.failedJobs > 0) {
    alerts.push(
      raise('failed_jobs', platform, facts.storeId, `${String(facts.failedJobs)} failed events in 24h`),
    );
  }

  if (facts.subscription?.status === 'past_due') {
    alerts.push(raise('past_due', platform, facts.storeId, 'payment has not been collected'));
  }

  return alerts;
}

export function platformUnreachableAlert(platform: PlatformId, detail: string): Alert {
  return raise('platform_unreachable', platform, null, detail);
}

/**
 * Marks the alerts an operator has already seen, and drops nothing.
 *
 * Acknowledged alerts stay in the list with a date on them rather than
 * disappearing: an operator who acknowledged something at 03:00 needs to be
 * able to see, at 09:00, what they said they had handled.
 */
export function applyAcks(
  alerts: readonly Alert[],
  acknowledgedAt: ReadonlyMap<string, Instant>,
  now: Instant,
): readonly Alert[] {
  const nowMs = new Date(now).getTime();
  return alerts.map((alert) => {
    const acked = acknowledgedAt.get(alert.key);
    if (acked === undefined) return alert;
    const expiresAtMs = new Date(acked).getTime() + ACK_TTL_MS;
    if (expiresAtMs <= nowMs) return alert;
    return { ...alert, acknowledgedUntil: new Date(expiresAtMs).toISOString() as Instant };
  });
}

/** Unacknowledged first — the list is read top-down during an incident. */
export function sortAlerts(alerts: readonly Alert[]): readonly Alert[] {
  const rank = (alert: Alert): number => (alert.acknowledgedUntil === null ? 0 : 1);
  return [...alerts].sort((a, b) => rank(a) - rank(b) || a.key.localeCompare(b.key));
}
