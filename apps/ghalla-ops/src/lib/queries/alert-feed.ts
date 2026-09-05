import { toInstant } from '@ghalla/contracts';
import { describeError } from '../errors';
import type { Instant, PlatformId } from '@ghalla/contracts';
import { queryPlatforms } from '../platforms/registry';
import type { PlatformRegistry } from '../platforms/registry';
import { UNAVAILABLE_ALERTS, applyAcks, platformUnreachableAlert, sortAlerts, storeAlerts } from './alerts';
import type { Alert } from './alerts';
import { storeSummaries } from './stores';
import type { StoreFacts } from './store-health';

/**
 * Every alert, across every platform, with acknowledgements applied.
 *
 * `acks` is a function rather than a database handle, so this composes without
 * the portal's own Postgres — which is what lets the whole feed be tested
 * against fixtures instead of two databases.
 */

export type AckLookup = () => Promise<ReadonlyMap<string, Instant>>;

export interface AlertFeed {
  readonly alerts: readonly Alert[];
  /** Alert types that cannot be computed yet, with the reason. Never silently absent. */
  readonly unavailable: Readonly<Record<string, string>>;
  /**
   * Set when the acknowledgement store could not be read, in which case every
   * alert below is shown UNACKNOWLEDGED.
   *
   * Degrading rather than failing: an operator in the middle of an incident
   * needs to see the alerts, and losing the "I have seen this" markers is a far
   * smaller loss than losing the list. Saying so is what stops a re-raised
   * alert being read as a new problem.
   */
  readonly acksUnavailable: string | null;
  readonly partial: boolean;
  readonly capturedAt: Instant;
}

async function readAcks(
  acks: AckLookup,
): Promise<{ readonly acks: ReadonlyMap<string, Instant>; readonly error: string | null }> {
  try {
    return { acks: await acks(), error: null };
  } catch (error) {
    return { acks: new Map(), error: describeError(error) };
  }
}

export async function alertFeed(
  registry: PlatformRegistry,
  acks: AckLookup,
  now: Date,
): Promise<AlertFeed> {
  const at = toInstant(now.toISOString());

  const [fan, acknowledged] = await Promise.all([
    queryPlatforms(registry, async (handle) => {
      const summaries = await storeSummaries(handle.db, now);
      return summaries.flatMap((summary) => {
        const facts: StoreFacts = {
          storeId: summary.storeId,
          installedAt: summary.installedAt,
          uninstalledAt: summary.uninstalledAt,
          subscription: summary.subscription,
          coverage: summary.coverage,
          lastWebhookAt: summary.lastWebhookAt,
          failedJobs: summary.failedJobs,
          backfill: summary.backfill,
          ordersInPeriod: summary.ordersInPeriod,
          dashboardSession: summary.activation.dashboardSession,
        };
        return storeAlerts(handle.platform, facts, at);
      });
    }),
    readAcks(acks),
  ]);

  // A platform that could not be read is itself an alert. Reporting the gap as
  // an absence of alerts would read as "nothing wrong", which is the opposite
  // of what an unreachable database means.
  const unreachable = fan.failed.map((failure) =>
    platformUnreachableAlert(failure.platform as PlatformId, failure.reason),
  );

  const raised = [...fan.ok.flatMap((result) => result.value), ...unreachable];

  return {
    alerts: sortAlerts(applyAcks(raised, acknowledged.acks, at)),
    unavailable: UNAVAILABLE_ALERTS,
    acksUnavailable: acknowledged.error,
    partial: fan.partial || acknowledged.error !== null,
    capturedAt: toInstant(fan.capturedAt),
  };
}
