import { Injectable, Logger } from '@nestjs/common';

/**
 * The billing numbers worth watching, and why each one earns its place.
 *
 * Counters in process, plus a structured log line per event. In-process because
 * there is one API service and no metrics backend yet; the log line is what
 * survives a restart, and it carries the same fields the counter does so a
 * dashboard can be built from either. When a metrics backend arrives this class
 * is the one place that changes.
 *
 * These are not vanity numbers. Each is the leading indicator of a specific
 * failure:
 *
 *   - `eventsDropped` rising means webhooks are arriving out of order more than
 *     expected, or an adapter is stamping `occurredAt` wrongly — which would
 *     silently reject every real change.
 *   - `corrections` rising is THE signal that the webhook path is broken.
 *     Reconciliation is a safety net; a net that keeps catching things means
 *     the thing above it has a hole. It should normally be zero.
 *   - `denials` by feature is a product input, not an ops one: it says what
 *     merchants are reaching for and therefore what to price into which tier.
 *   - `overCap` by plan says whether a cap is set where it converts or where it
 *     merely annoys.
 */
@Injectable()
export class BillingMetrics {
  private readonly logger = new Logger(BillingMetrics.name);

  private readonly counters = new Map<string, number>();

  private bump(key: string): void {
    this.counters.set(key, (this.counters.get(key) ?? 0) + 1);
  }

  eventReceived(type: string): void {
    this.bump(`events.received.${type}`);
  }

  eventProcessed(type: string): void {
    this.bump(`events.processed.${type}`);
  }

  /**
   * Logged at WARN, not INFO.
   *
   * A dropped event is expected occasionally and alarming in volume, and warn
   * is the level that makes the second visible without making the first noisy.
   */
  eventDroppedAsStale(type: string, storeId: string, reason: string): void {
    this.bump(`events.dropped_stale.${type}`);
    this.logger.warn({ message: 'billing event dropped as stale', type, storeId, reason });
  }

  eventUnmatched(type: string, platformStoreId: string): void {
    this.bump(`events.unmatched.${type}`);
    this.logger.warn({ message: 'billing event for an unknown store', type, platformStoreId });
  }

  /** Every correction is logged individually — the count says there is a problem, the line says which store. */
  reconciliationCorrection(storeId: string, from: string, to: string): void {
    this.bump('reconciliation.corrections');
    this.logger.warn({
      message: 'reconciliation corrected a subscription the webhooks got wrong',
      storeId,
      from,
      to,
    });
  }

  reconciliationChecked(): void {
    this.bump('reconciliation.checked');
  }

  reconciliationFailed(storeId: string, error: string): void {
    this.bump('reconciliation.failures');
    this.logger.error({ message: 'reconciliation failed for a store', storeId, error });
  }

  overCap(planCode: string): void {
    this.bump(`usage.over_cap.${planCode}`);
  }

  entitlementDenied(feature: string, planCode: string): void {
    this.bump(`entitlement.denied.${feature}`);
    this.logger.log({ message: 'entitlement denied', feature, planCode });
  }

  /** A row naming a plan this build has never heard of — a rollback serving merchants. */
  planUnknown(planCode: string): void {
    this.bump('plan.unknown');
    this.logger.error({ message: 'subscription names a plan this build does not know', planCode });
  }

  trialConverted(planCode: string): void {
    this.bump(`trial.converted.${planCode}`);
    this.logger.log({ message: 'trial converted to paid', planCode });
  }

  trialExpired(): void {
    this.bump('trial.expired');
  }

  snapshot(): Readonly<Record<string, number>> {
    return Object.fromEntries(this.counters);
  }
}
