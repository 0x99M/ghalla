import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { SubscriptionRepository } from '@ghalla/persistence';
import { SubscriptionRefreshService } from './subscription-refresh.service.js';
import type { RefreshResult } from './subscription-refresh.service.js';

export interface ReconciliationSummary {
  readonly checked: number;
  readonly created: number;
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
 *
 * The per-store work is NOT here. It lives in `SubscriptionRefreshService`,
 * shared with the install handshake and the merchant's refresh button, because
 * three implementations of "ask the platform and write down the answer" would
 * drift into disagreeing about the same store.
 */
@Injectable()
export class ReconciliationService {
  private readonly logger = new Logger(ReconciliationService.name);

  constructor(
    private readonly subscriptions: SubscriptionRepository,
    private readonly refresh: SubscriptionRefreshService,
  ) {}

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
    const due = await this.subscriptions.dueForReconciliation(limit);

    // Tallied by outcome rather than switched on. A `case` per kind spends a
    // branch on each — including `created`, which this sweep cannot produce
    // because it only ever walks rows that already exist — and reads as six
    // decisions where there is really one count.
    const tally = new Map<RefreshResult['kind'], number>();
    for (const subscription of due) {
      const result = await this.refresh.refreshNow(subscription.storeId);
      tally.set(result.kind, (tally.get(result.kind) ?? 0) + 1);
    }
    const count = (kind: RefreshResult['kind']): number => tally.get(kind) ?? 0;

    const summary: ReconciliationSummary = {
      checked: due.length,
      created: count('created'),
      corrected: count('corrected'),
      failed: count('failed'),
      // `unavailable` means no source is wired; `unrecognised` means the
      // platform does not know the store. Neither is a correction, and both
      // leave the row alone.
      skipped: count('unavailable') + count('unrecognised'),
    };

    if (count('unavailable') === due.length && due.length > 0) {
      this.logger.warn({
        message: 'reconciliation checked nothing; is a subscription source wired?',
        stores: due.length,
      });
    }

    return summary;
  }
}
