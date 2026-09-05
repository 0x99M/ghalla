import { and, eq, gte, lt, sql } from 'drizzle-orm';
import { usageWindow } from '@ghalla/billing';
import type { BillingPeriod } from '@ghalla/billing';
import { orders, storeSubscription } from '@ghalla/persistence/schema';
import { toDateFromInstant } from '@ghalla/persistence/codec';
import type { ReadOnlyDatabase } from '../platforms/read-only';
import { aggregateRow } from './row';
import type { InstantWindow } from './window';

/**
 * Order counts, and the one that has to agree with the merchant's own screen.
 *
 * `ordersInPeriod` is the metering number. Three things about it are load
 * bearing and all three are ways this goes quietly wrong:
 *
 *   - `ingestion_source = 'live'` only. A backfill is history the merchant had
 *     before they had heard of us; metering it means they install, we import
 *     three years, and they blow a 300-order cap on their first afternoon.
 *   - the SUBSCRIPTION's period, never a calendar month. The two coincide for
 *     nobody except a merchant who happened to subscribe on the first.
 *   - HALF-OPEN. An order on the final millisecond belongs to the period that
 *     is ending; a closed interval bills it against a cap twice.
 *
 * The single-store form goes through `usageWindow` from `@ghalla/billing`,
 * which is the canonical definition — the same one the merchant's usage banner
 * counts with. The batch form expresses the same window as a join, because
 * running one query per store to draw a list is how a list page becomes a
 * four-second page, and a test pins the two together.
 */

const LIVE = 'live';

export async function ordersInPeriod(
  db: ReadOnlyDatabase,
  storeId: string,
  period: BillingPeriod,
): Promise<number> {
  const window = usageWindow(period);
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(orders)
    .where(
      and(
        eq(orders.storeId, storeId),
        eq(orders.ingestionSource, LIVE),
        gte(orders.placedAt, toDateFromInstant(window.from)),
        lt(orders.placedAt, toDateFromInstant(window.to)),
      ),
    );
  return aggregateRow(rows, { n: 0 }).n;
}

/**
 * Every store's count in one query, joined on the subscription's own window.
 *
 * A LEFT JOIN, so a store with no orders in its period appears with zero rather
 * than vanishing — a store list that silently drops its quietest stores is
 * hiding exactly the ones worth looking at.
 */
export async function ordersInPeriodByStore(db: ReadOnlyDatabase): Promise<Map<string, number>> {
  const rows = await db
    .select({
      storeId: storeSubscription.storeId,
      n: sql<number>`count(${orders.id})::int`,
    })
    .from(storeSubscription)
    .leftJoin(
      orders,
      and(
        eq(orders.storeId, storeSubscription.storeId),
        eq(orders.ingestionSource, LIVE),
        gte(orders.placedAt, storeSubscription.currentPeriodStart),
        lt(orders.placedAt, storeSubscription.currentPeriodEnd),
      ),
    )
    .groupBy(storeSubscription.storeId);

  return new Map(rows.map((row) => [row.storeId, row.n]));
}

/** Live orders ingested inside a window. The platform's activity signal. */
export async function ordersIngested(db: ReadOnlyDatabase, window: InstantWindow): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(orders)
    .where(
      and(
        eq(orders.ingestionSource, LIVE),
        gte(orders.placedAt, toDateFromInstant(window.from)),
        lt(orders.placedAt, toDateFromInstant(window.to)),
      ),
    );
  return aggregateRow(rows, { n: 0 }).n;
}
