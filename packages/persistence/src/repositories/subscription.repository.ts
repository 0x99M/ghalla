import { and, asc, count, eq, gte, lt, sql } from 'drizzle-orm';
import { SUBSCRIPTION_STATUSES } from '@ghalla/contracts';
import type { Instant, StoreId } from '@ghalla/contracts';
import type { Subscription, UsageWindow } from '@ghalla/billing';
import type { Database } from '../db/pool.js';
import { orders, storeSubscription } from '../db/schema.js';
import { toDateFromInstant, toEnumFromColumn, toIdFromColumn, toInstantFromDate, toInstantFromDateOrNull } from '../db/codec.js';

/**
 * The subscription row, and the usage derived from orders.
 *
 * Both live here because they answer one question together — "may this store do
 * this, and how much of its allowance is gone" — and because the second is
 * measured against a window that only the first knows.
 */
export class SubscriptionRepository {
  constructor(private readonly db: Database) {}

  private static toDomain(row: typeof storeSubscription.$inferSelect): Subscription {
    return {
      storeId: toIdFromColumn<'store'>(row.storeId) as StoreId,
      planCode: row.planCode,
      platformPlanId: row.platformPlanId,
      status: toEnumFromColumn(row.status, SUBSCRIPTION_STATUSES, 'store_subscription.status'),
      trialEndsAt: toInstantFromDateOrNull(row.trialEndsAt),
      currentPeriodStart: toInstantFromDate(row.currentPeriodStart),
      currentPeriodEnd: toInstantFromDate(row.currentPeriodEnd),
      lastEventAt: toInstantFromDateOrNull(row.lastEventAt),
      lastReconciledAt: toInstantFromDateOrNull(row.lastReconciledAt),
      pendingPlanCode: row.pendingPlanCode,
      pendingPlanEffectiveAt: toInstantFromDateOrNull(row.pendingPlanEffectiveAt),
    };
  }

  /**
   * THE request-path read. One primary-key lookup, no join, no network call.
   *
   * Returns `null` for a store with no subscription row at all — an install
   * whose billing webhook has not landed yet. The caller decides what that
   * means; guessing here would put an entitlement decision in a repository.
   */
  async find(storeId: StoreId): Promise<Subscription | null> {
    const [row] = await this.db
      .select()
      .from(storeSubscription)
      .where(eq(storeSubscription.storeId, storeId));
    return row === undefined ? null : SubscriptionRepository.toDomain(row);
  }

  /**
   * Writes the row, creating it if the store has none.
   *
   * An upsert rather than insert-or-update, because the first billing event for
   * a store and the fiftieth arrive through exactly the same path and a
   * read-then-branch would race two deliveries of the first one.
   */
  async save(subscription: Subscription, now: Instant): Promise<void> {
    const values = {
      storeId: subscription.storeId,
      planCode: subscription.planCode,
      platformPlanId: subscription.platformPlanId,
      status: subscription.status,
      trialEndsAt: subscription.trialEndsAt === null ? null : toDateFromInstant(subscription.trialEndsAt),
      currentPeriodStart: toDateFromInstant(subscription.currentPeriodStart),
      currentPeriodEnd: toDateFromInstant(subscription.currentPeriodEnd),
      lastEventAt: subscription.lastEventAt === null ? null : toDateFromInstant(subscription.lastEventAt),
      lastReconciledAt:
        subscription.lastReconciledAt === null ? null : toDateFromInstant(subscription.lastReconciledAt),
      pendingPlanCode: subscription.pendingPlanCode,
      pendingPlanEffectiveAt:
        subscription.pendingPlanEffectiveAt === null
          ? null
          : toDateFromInstant(subscription.pendingPlanEffectiveAt),
      updatedAt: toDateFromInstant(now),
    };

    await this.db
      .insert(storeSubscription)
      .values(values)
      .onConflictDoUpdate({ target: storeSubscription.storeId, set: values });
  }

  /**
   * Orders placed in the window, LIVE ingestion only.
   *
   * Derived, never counted. A stored counter drifts the moment anything is not
   * a clean single delivery — a retried webhook, a replay, a backfill, a
   * refund — and every one of those is normal here. This is one aggregate over
   * an index that exists for it.
   *
   * `ingestion_source = 'live'` is the load-bearing clause, not a detail: a
   * merchant's historical import is a one-time job they did before they had
   * heard of us, and metering it means blowing a 300-order cap on install day.
   */
  async countLiveOrders(storeId: StoreId, window: UsageWindow): Promise<number> {
    const rows = await this.db
      .select({ n: count() })
      .from(orders)
      .where(
        and(
          eq(orders.storeId, storeId),
          // Half-open. A closed interval counts the boundary order twice: once
          // against the cap the merchant already paid for, and once against the
          // one they just renewed.
          gte(orders.placedAt, toDateFromInstant(window.from)),
          lt(orders.placedAt, toDateFromInstant(window.to)),
          eq(orders.ingestionSource, 'live'),
        ),
      );
    // Summed rather than read off `rows[0]`. A COUNT returns one row or none,
    // and summing says that without a `?? 0` for a case that cannot arise.
    return rows.reduce((total, row) => total + row.n, 0);
  }

  /**
   * The reconciler's work list, staleest first.
   *
   * Ordered so a pass that cannot finish every store still makes progress on
   * the ones that have gone longest without being checked, rather than
   * re-checking the same prefix every night. `NULLS FIRST` puts a store that
   * has never been reconciled at the head, which is where it belongs.
   */
  async dueForReconciliation(limit: number): Promise<readonly Subscription[]> {
    const rows = await this.db
      .select()
      .from(storeSubscription)
      .orderBy(sql`${storeSubscription.lastReconciledAt} ASC NULLS FIRST`, asc(storeSubscription.storeId))
      .limit(limit);
    return rows.map((row) => SubscriptionRepository.toDomain(row));
  }

  /** Marks a store checked even when nothing changed, so the sweep advances. */
  async markReconciled(storeId: StoreId, at: Instant): Promise<void> {
    await this.db
      .update(storeSubscription)
      .set({ lastReconciledAt: toDateFromInstant(at), updatedAt: toDateFromInstant(at) })
      .where(eq(storeSubscription.storeId, storeId));
  }

  /**
   * Puts a store at the head of the reconciler's queue.
   *
   * Clearing `last_reconciled_at` rather than adding a "please check me" flag:
   * the sweep already orders NULLS FIRST, so this reuses the ordering that
   * exists instead of inventing a second one that could disagree with it. It
   * also means a refresh request survives a restart — the row is the queue.
   */
  async markDueForReconciliation(storeId: StoreId): Promise<void> {
    await this.db
      .update(storeSubscription)
      .set({ lastReconciledAt: null })
      .where(eq(storeSubscription.storeId, storeId));
  }

  /** Store counts by status, for the observability surface. */
  async countByStatus(): Promise<Readonly<Record<string, number>>> {
    const rows = await this.db
      .select({ status: storeSubscription.status, n: count() })
      .from(storeSubscription)
      .groupBy(storeSubscription.status);
    const out: Record<string, number> = {};
    for (const status of SUBSCRIPTION_STATUSES) out[status] = 0;
    for (const row of rows) {
      out[toEnumFromColumn(row.status, SUBSCRIPTION_STATUSES, 'store_subscription.status')] = row.n;
    }
    return out;
  }
}
