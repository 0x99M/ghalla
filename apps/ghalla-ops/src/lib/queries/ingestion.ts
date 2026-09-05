import { and, desc, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import type { Instant } from '@ghalla/contracts';
import { backfillCursors, orderPayments, orders, webhookEvents } from '@ghalla/persistence/schema';
import { toDateFromInstant, toInstantFromDateOrNull } from '@ghalla/persistence/codec';
import { aggregateRow, toInstantFromAggregate } from './row';
import type { ReadOnlyDatabase } from '../platforms/read-only';
import type { InstantWindow } from './window';

/**
 * Whether data is arriving, and whether it is being processed.
 *
 * This is the half of the portal that answers "is anything broken", and every
 * number in it is a count over `webhook_events` or `backfill_cursors`. Nothing
 * here is stored as a rate: the success ratio is two counts until the moment it
 * is displayed, because a stored percentage cannot be re-weighted when it is
 * combined with another platform's.
 */

export interface IngestionHealth {
  readonly processed: number;
  readonly failed: number;
  readonly skipped: number;
  /** Waiting to be claimed. THE queue depth. */
  readonly pending: number;
  /** Claimed by a worker right now. */
  readonly processing: number;
  /**
   * Claimed by a worker that has not let go for longer than a worker should
   * take. A crashed worker leaves rows here, and a rising count is the signal
   * the reaper is not running.
   */
  readonly stalled: number;
  readonly oldestPendingAt: Instant | null;
}

/** How long a `processing` row may be held before it is treated as abandoned. */
export const STALL_THRESHOLD_MS = 5 * 60 * 1000;

export async function ingestionHealth(
  db: ReadOnlyDatabase,
  window: InstantWindow,
  now: Date,
): Promise<IngestionHealth> {
  const stalledBefore = new Date(now.getTime() - STALL_THRESHOLD_MS);

  // Two queries, not one, and the split is deliberate. The processed/failed
  // counts are over a WINDOW — how has ingestion been going — while the queue
  // depth is a snapshot of right now. Folding them together would either
  // window the queue depth, which is meaningless, or unwindow the success
  // counts, which would make a platform look unhealthy for a fault it recovered
  // from three weeks ago.
  const [windowed, queue] = await Promise.all([
    db
      .select({
        processed: sql<number>`count(*) filter (where ${webhookEvents.status} = 'processed')::int`,
        failed: sql<number>`count(*) filter (where ${webhookEvents.status} = 'failed')::int`,
        skipped: sql<number>`count(*) filter (where ${webhookEvents.status} = 'skipped')::int`,
      })
      .from(webhookEvents)
      .where(
        and(
          gte(webhookEvents.receivedAt, toDateFromInstant(window.from)),
          lt(webhookEvents.receivedAt, toDateFromInstant(window.to)),
        ),
      ),
    db
      .select({
        pending: sql<number>`count(*) filter (where ${webhookEvents.status} = 'pending')::int`,
        processing: sql<number>`count(*) filter (where ${webhookEvents.status} = 'processing')::int`,
        stalled: sql<number>`count(*) filter (where ${webhookEvents.status} = 'processing' and ${webhookEvents.lockedAt} < ${stalledBefore})::int`,
        oldestPendingAt: sql<unknown>`min(${webhookEvents.receivedAt}) filter (where ${webhookEvents.status} = 'pending')`,
      })
      .from(webhookEvents),
  ]);

  const counts = aggregateRow(windowed, { processed: 0, failed: 0, skipped: 0 });
  const depth = aggregateRow(queue, {
    pending: 0,
    processing: 0,
    stalled: 0,
    oldestPendingAt: null as unknown,
  });

  return {
    processed: counts.processed,
    failed: counts.failed,
    skipped: counts.skipped,
    pending: depth.pending,
    processing: depth.processing,
    stalled: depth.stalled,
    oldestPendingAt: toInstantFromAggregate(depth.oldestPendingAt),
  };
}

/**
 * Success rate, derived at the point of display and nowhere else.
 *
 * `null` rather than 100% when nothing arrived: a platform with no traffic has
 * not achieved a perfect success rate, and painting one green is how a silent
 * integration goes unnoticed for a week.
 */
export function successRateBps(processed: number, failed: number): number | null {
  const total = processed + failed;
  if (total === 0) return null;
  return Math.round((processed * 10_000) / total);
}

/**
 * `Instant | null` in the map rather than a filtered `Instant`.
 *
 * Grouping by store means every group has a row, so `max()` cannot be null —
 * and dropping the impossible entry would have been a branch no query can take.
 * Callers already coalesce a missing store to `null`, so this costs nothing.
 */
export async function lastWebhookByStore(db: ReadOnlyDatabase): Promise<Map<string, Instant | null>> {
  const rows = await db
    .select({
      storeId: webhookEvents.storeId,
      lastAt: sql<unknown>`max(${webhookEvents.receivedAt})`,
    })
    .from(webhookEvents)
    .groupBy(webhookEvents.storeId);

  return new Map(rows.map((row) => [row.storeId, toInstantFromAggregate(row.lastAt)]));
}

export async function failedJobsByStore(
  db: ReadOnlyDatabase,
  window: InstantWindow,
): Promise<Map<string, number>> {
  const rows = await db
    .select({ storeId: webhookEvents.storeId, n: sql<number>`count(*)::int` })
    .from(webhookEvents)
    .where(
      and(
        eq(webhookEvents.status, 'failed'),
        gte(webhookEvents.receivedAt, toDateFromInstant(window.from)),
        lt(webhookEvents.receivedAt, toDateFromInstant(window.to)),
      ),
    )
    .groupBy(webhookEvents.storeId);

  return new Map(rows.map((row) => [row.storeId, row.n]));
}

export interface FailedEvent {
  readonly id: string;
  readonly storeId: string;
  readonly eventType: string;
  readonly rawEventType: string;
  readonly receivedAt: Instant | null;
  readonly attempts: number;
  readonly lastError: string | null;
}

/**
 * The triage list. Newest first, because the newest failure is the one still
 * happening.
 *
 * `storeId` NARROWS THE QUERY rather than the result, and that distinction is
 * the whole point. `failed` is a terminal dead-letter state — nothing clears it
 * but an explicit replay — so the rows accumulate, and on a platform with more
 * than a handful of stores the newest twenty all belong to whichever store is
 * loudest. Taking the platform's twenty and filtering afterwards therefore
 * shows a store's failures only when it happens to be the loud one, and an
 * empty list reads as "this store has no failures". That is the wrong answer on
 * the exact screen somebody opened because they think this store is broken.
 *
 * The predicate rides the existing `webhook_events_store_received_idx`.
 */
export async function recentFailures(
  db: ReadOnlyDatabase,
  limit: number,
  storeId?: string | undefined,
): Promise<readonly FailedEvent[]> {
  const rows = await db
    .select({
      id: webhookEvents.id,
      storeId: webhookEvents.storeId,
      eventType: webhookEvents.eventType,
      rawEventType: webhookEvents.rawEventType,
      receivedAt: webhookEvents.receivedAt,
      attempts: webhookEvents.attempts,
      lastError: webhookEvents.lastError,
    })
    .from(webhookEvents)
    .where(
      and(
        eq(webhookEvents.status, 'failed'),
        storeId === undefined ? undefined : eq(webhookEvents.storeId, storeId),
      ),
    )
    .orderBy(desc(webhookEvents.receivedAt))
    .limit(limit);

  return rows.map((row) => ({ ...row, receivedAt: toInstantFromDateOrNull(row.receivedAt) }));
}

export interface BackfillState {
  readonly status: string;
  readonly itemsFetched: number;
  readonly startedAt: Instant | null;
  readonly lastAdvancedAt: Instant | null;
}

/** The ORDERS backfill only. It is the one the activation funnel turns on. */
export async function orderBackfillByStore(db: ReadOnlyDatabase): Promise<Map<string, BackfillState>> {
  const rows = await db
    .select({
      storeId: backfillCursors.storeId,
      status: backfillCursors.status,
      itemsFetched: backfillCursors.itemsFetched,
      startedAt: backfillCursors.createdAt,
      lastAdvancedAt: backfillCursors.lastAdvancedAt,
    })
    .from(backfillCursors)
    .where(eq(backfillCursors.resource, 'orders'));

  return new Map(
    rows.map((row) => [
      row.storeId,
      {
        status: row.status,
        itemsFetched: row.itemsFetched,
        startedAt: toInstantFromDateOrNull(row.startedAt),
        lastAdvancedAt: toInstantFromDateOrNull(row.lastAdvancedAt),
      },
    ]),
  );
}

export interface UnknownPaymentMethod {
  readonly storeId: string;
  readonly instrument: string;
  readonly rawMethodLabel: string;
  readonly orders: number;
}

/**
 * Payment methods an adapter could not map — the queue that turns into fee
 * rules.
 *
 * `unknown` and `other` are first-class instruments precisely so an adapter
 * never has to guess, and this is what makes that honesty actionable: an
 * unmapped rail is a gateway fee priced by fallback, which is a margin the
 * merchant is being shown that we cannot stand behind. Ranked by order count,
 * because the label appearing on four hundred orders is worth a rule and the
 * one appearing on two is not.
 */
export async function unknownPaymentMethods(
  db: ReadOnlyDatabase,
  limit: number,
): Promise<readonly UnknownPaymentMethod[]> {
  // COUNT DISTINCT ORDERS, not rows. `order_payments` holds one row per LEG —
  // `unique(order_id, leg_index)` exists because an order can settle in
  // several captures — so `count(*)` counts an order once per leg and ranks a
  // rail by how often it is split rather than by how much of the business uses
  // it. The field is named `orders` and the ranking is a work list, so it has
  // to be orders.
  const distinctOrders = sql<number>`count(distinct ${orders.id})::int`;

  const rows = await db
    .select({
      storeId: orders.storeId,
      instrument: orderPayments.instrument,
      rawMethodLabel: orderPayments.rawMethodLabel,
      orders: distinctOrders,
    })
    .from(orderPayments)
    .innerJoin(orders, eq(orders.id, orderPayments.orderId))
    .where(
      and(
        inArray(orderPayments.instrument, ['unknown', 'other']),
        // A merchant's test order is not evidence that a rail deserves a fee
        // rule, and counting it inflates the one number this list ranks by.
        eq(orders.isTest, false),
      ),
    )
    .groupBy(orders.storeId, orderPayments.instrument, orderPayments.rawMethodLabel)
    .orderBy(sql`count(distinct ${orders.id}) desc`)
    .limit(limit);

  return rows;
}
