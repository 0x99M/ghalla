import { and, eq, gte, lt, sql } from 'drizzle-orm';
import type { Minor } from '@ghalla/contracts';
import { dailyStoreRollup } from '@ghalla/persistence/schema';
import { numericToMinor } from '@ghalla/persistence/money';
import type { ReadOnlyDatabase } from '../platforms/read-only';
import { aggregateRow } from './row';
import type { DateWindow } from './window';

/**
 * Cost coverage: how much of a merchant's revenue we can actually price.
 *
 * REVENUE-WEIGHTED, never SKU-count-weighted. "80% of SKUs have costs" and "80%
 * of revenue is covered" are different numbers, and only the second one says
 * whether the margin on the screen means anything — a merchant can have costs
 * on every long-tail SKU and none on the three products that are the business.
 *
 * The numerator and denominator are summed separately and divided ONCE. That is
 * the same arrangement `order_profit` uses upstream, and its comment gives the
 * reason: an average of per-order percentages is not the store's percentage
 * unless every rollup remembers to weight it, and the one that forgets is
 * unfalsifiably wrong.
 *
 * Read from `daily_store_rollup` rather than `order_profit` because both terms
 * are already there per day, which turns a scan of every order into a scan of
 * one row per store per day. The price of that is staleness, so `dirtyBuckets`
 * comes back beside the number: a rollup awaiting rebuild is a figure that will
 * change, and an operator deserves to know they are looking at one.
 */

export interface Coverage {
  readonly revenueExVatMinor: Minor;
  readonly coveredRevenueExVatMinor: Minor;
  /** `null` when there is no revenue: a ratio to nothing is nothing, not zero. */
  readonly coverageBps: number | null;
  readonly ordersCount: number;
  readonly dirtyBuckets: number;
}

export function toCoverageBps(covered: Minor, revenue: Minor): number | null {
  if (revenue <= 0) return null;
  // Integer arithmetic throughout: both terms are halalas, and multiplying
  // before dividing keeps the basis points exact rather than rounding a float.
  return Math.round((covered * 10_000) / revenue);
}

const REVENUE = sql<string>`coalesce(sum(${dailyStoreRollup.revenueExVatMinor}), '0.00')`;
const COVERED = sql<string>`coalesce(sum(${dailyStoreRollup.costCoveredRevenueExVatMinor}), '0.00')`;
const ORDERS = sql<number>`coalesce(sum(${dailyStoreRollup.ordersCount}), 0)::int`;
const DIRTY = sql<number>`count(*) filter (where ${dailyStoreRollup.dirty})::int`;

function toCoverage(row: {
  revenue: string;
  covered: string;
  orders: number;
  dirty: number;
}): Coverage {
  const revenue = numericToMinor(row.revenue);
  const covered = numericToMinor(row.covered);
  return {
    revenueExVatMinor: revenue,
    coveredRevenueExVatMinor: covered,
    coverageBps: toCoverageBps(covered, revenue),
    ordersCount: row.orders,
    dirtyBuckets: row.dirty,
  };
}

const EMPTY_ROW = { revenue: '0.00', covered: '0.00', orders: 0, dirty: 0 };

export async function platformCoverage(db: ReadOnlyDatabase, window: DateWindow): Promise<Coverage> {
  const rows = await db
    .select({ revenue: REVENUE, covered: COVERED, orders: ORDERS, dirty: DIRTY })
    .from(dailyStoreRollup)
    .where(
      and(
        gte(dailyStoreRollup.businessDate, window.from),
        lt(dailyStoreRollup.businessDate, window.to),
      ),
    );

  return toCoverage(aggregateRow(rows, EMPTY_ROW));
}

export async function storeCoverage(
  db: ReadOnlyDatabase,
  storeId: string,
  window: DateWindow,
): Promise<Coverage> {
  const rows = await db
    .select({ revenue: REVENUE, covered: COVERED, orders: ORDERS, dirty: DIRTY })
    .from(dailyStoreRollup)
    .where(
      and(
        eq(dailyStoreRollup.storeId, storeId),
        gte(dailyStoreRollup.businessDate, window.from),
        lt(dailyStoreRollup.businessDate, window.to),
      ),
    );

  return toCoverage(aggregateRow(rows, EMPTY_ROW));
}

/** One row per store, for the list and for the health derivation. */
export async function coverageByStore(
  db: ReadOnlyDatabase,
  window: DateWindow,
): Promise<Map<string, Coverage>> {
  const rows = await db
    .select({
      storeId: dailyStoreRollup.storeId,
      revenue: REVENUE,
      covered: COVERED,
      orders: ORDERS,
      dirty: DIRTY,
    })
    .from(dailyStoreRollup)
    .where(
      and(
        gte(dailyStoreRollup.businessDate, window.from),
        lt(dailyStoreRollup.businessDate, window.to),
      ),
    )
    .groupBy(dailyStoreRollup.storeId);

  return new Map(rows.map((row) => [row.storeId, toCoverage(row)]));
}
