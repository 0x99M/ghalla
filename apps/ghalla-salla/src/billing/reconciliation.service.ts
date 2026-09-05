import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { toInstant } from '@ghalla/contracts';
import type { Instant } from '@ghalla/contracts';
import { isPlanCode, reconcile } from '@ghalla/billing';
import type { SubscriptionChange } from '@ghalla/billing';
import type { PlatformSubscription } from '@ghalla/ports';
import { SubscriptionRepository } from '@ghalla/persistence';
import { BillingMetrics } from './billing.metrics.js';

/**
 * How the reconciler reaches the platform.
 *
 * Deliberately narrower than `BillingAdapter`: the reconciler needs one
 * question answered per store and has no business holding a whole adapter, and
 * this way the credentials lookup — which the adapter port explicitly refuses
 * to do, since it cannot resolve our store ids — has somewhere to live.
 *
 * Unimplemented until the Salla adapter lands. The reconciler is written and
 * tested against this interface now so that the adapter arrives into a slot
 * rather than a design decision.
 */
export interface SubscriptionSource {
  fetch(storeId: string): Promise<PlatformSubscription | null>;
}

export const SUBSCRIPTION_SOURCE = Symbol('SUBSCRIPTION_SOURCE');

export interface ReconciliationSummary {
  readonly checked: number;
  readonly corrected: number;
  readonly failed: number;
  readonly skipped: number;
}

/**
 * Nightly drift repair.
 *
 * Webhooks get dropped. A deploy restarts mid-delivery, a handler has a bug,
 * the platform's own delivery fails and exhausts its retries. Treating them as
 * the sole source of truth GUARANTEES that eventually someone loses access they
 * paid for, or keeps access they cancelled — and in both cases the discovery is
 * made by a customer rather than by us.
 *
 * So this exists to be boring. Its correction count should sit at zero, and the
 * value of the metric is entirely in the fact that a rise is legible: it means
 * the webhook path above it has a hole.
 */
@Injectable()
export class ReconciliationService {
  private readonly logger = new Logger(ReconciliationService.name);

  constructor(
    private readonly subscriptions: SubscriptionRepository,
    private readonly metrics: BillingMetrics,
    @Optional() @Inject(SUBSCRIPTION_SOURCE) private readonly source: SubscriptionSource | null = null,
  ) {}

  protected nowInstant(): Instant {
    return toInstant(new Date().toISOString());
  }

  /**
   * 03:00 UTC — 06:00 in Riyadh, which is the quietest hour for the merchants
   * this serves and well clear of the midnight boundary where period rollovers
   * and business-date bucketing are both happening.
   */
  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async runNightly(): Promise<void> {
    const summary = await this.runOnce(500);
    this.logger.log({ message: 'nightly subscription reconciliation complete', ...summary });
  }

  /**
   * One pass. Separated from the schedule so it is callable by hand during an
   * incident and testable without waiting for 3am.
   *
   * Failures are counted and stepped over rather than aborting the sweep: one
   * store whose credentials have been revoked must not stop the other four
   * hundred from being checked.
   */
  async runOnce(limit: number): Promise<ReconciliationSummary> {
    if (this.source === null) {
      // No adapter wired yet. Explicit and logged, because a reconciler that
      // silently does nothing is indistinguishable from one that finds no
      // drift — and those are opposite situations.
      this.logger.warn({ message: 'reconciliation skipped: no subscription source is wired' });
      return { checked: 0, corrected: 0, failed: 0, skipped: 1 };
    }

    const due = await this.subscriptions.dueForReconciliation(limit);
    const at = this.nowInstant();
    let corrected = 0;
    let failed = 0;
    let skipped = 0;

    for (const subscription of due) {
      try {
        const truth = await this.source.fetch(subscription.storeId);
        if (truth === null) {
          // The platform does not recognise this store — usually an uninstall
          // whose webhook we missed. NOT auto-cancelled here: revoking access
          // on a null answer makes a transient API fault indistinguishable
          // from an uninstall, and one of those is a paying customer.
          skipped += 1;
          this.logger.warn({
            message: 'platform returned no subscription for a store we have a row for',
            storeId: subscription.storeId,
          });
          await this.subscriptions.markReconciled(subscription.storeId, at);
          continue;
        }

        const change: SubscriptionChange = {
          status: truth.facts.status,
          planCode:
            truth.facts.planCode !== null && isPlanCode(truth.facts.planCode)
              ? truth.facts.planCode
              : null,
          platformPlanId: truth.facts.platformPlanId,
          trialEndsAt: truth.facts.trialEndsAt,
          currentPeriodStart: truth.facts.currentPeriodStart,
          currentPeriodEnd: truth.facts.currentPeriodEnd,
          occurredAt: truth.observedAt,
        };

        const outcome = reconcile(subscription, change, at);
        this.metrics.reconciliationChecked();

        if (outcome.kind === 'applied') {
          await this.subscriptions.save(outcome.next, at);
          this.metrics.reconciliationCorrection(
            subscription.storeId,
            subscription.status,
            outcome.next.status,
          );
          corrected += 1;
        } else {
          await this.subscriptions.markReconciled(subscription.storeId, at);
        }
      } catch (error) {
        failed += 1;
        this.metrics.reconciliationFailed(
          subscription.storeId,
          error instanceof Error ? error.message : String(error),
        );
      }
    }

    return { checked: due.length, corrected, failed, skipped };
  }
}
