import { sql } from 'drizzle-orm';
import { toInstant } from '@ghalla/contracts';
import type { Instant, PlatformId } from '@ghalla/contracts';
import { stores } from '@ghalla/persistence/schema';
import { toInstantFromDateOrNull } from '@ghalla/persistence/codec';
import type { ReadOnlyDatabase } from '../platforms/read-only';
import { coverageByStore } from './coverage';
import { failedJobsByStore, lastWebhookByStore, orderBackfillByStore } from './ingestion';
import type { BackfillState } from './ingestion';
import { ordersInPeriodByStore } from './orders';
import { aggregateRow } from './row';
import { activation, storeHealth } from './store-health';
import type { Activation, StoreFacts, StoreHealth } from './store-health';
import { subscriptionsByStore } from './subscriptions';
import { COVERAGE_DAYS, DAY_MS, trailingDays, trailingHours } from './window';
import type { Coverage } from './coverage';
import type { SubscriptionRow } from './subscriptions';

/**
 * One store, everything the portal knows about it.
 *
 * Gathered as SIX aggregate queries rather than one per store. The obvious
 * shape — list the stores, then ask each of them for its coverage, its last
 * webhook, its order count — is N+1 against a database the integration service
 * is also using, and it turns a page that should take 40ms into one that takes
 * four seconds and holds a connection for all of it.
 */

export interface StoreSummary {
  readonly storeId: string;
  readonly platformStoreId: string;
  readonly currency: string;
  readonly timezone: string;
  readonly installedAt: Instant;
  readonly uninstalledAt: Instant | null;
  readonly subscription: SubscriptionRow | null;
  readonly coverage: Coverage | null;
  readonly lastWebhookAt: Instant | null;
  readonly failedJobs: number;
  /** Carried, not just used: the alert feed derives from a summary and needs it. */
  readonly backfill: BackfillState | null;
  readonly ordersInPeriod: number;
  readonly health: StoreHealth;
  readonly activation: Activation;
}

/**
 * How many stores exist, from the table the store list pages over.
 *
 * Its own query rather than `storeSummaries().length`, because the overview
 * wants one number and that function does six aggregates to build seven fields
 * per store.
 */
export async function countStores(db: ReadOnlyDatabase): Promise<number> {
  const rows = await db.select({ n: sql<number>`count(*)::int` }).from(stores);
  return aggregateRow(rows, { n: 0 }).n;
}

export async function storeSummaries(
  db: ReadOnlyDatabase,
  now: Date,
): Promise<readonly StoreSummary[]> {
  const at = toInstant(now.toISOString());
  const coverageWindow = trailingDays(COVERAGE_DAYS, now);
  const failureWindow = trailingHours(DAY_MS / 3_600_000, now);

  const [rows, subscriptions, coverage, lastWebhook, failedJobs, backfill, ordersInPeriod] =
    await Promise.all([
      db
        .select({
          id: stores.id,
          platformStoreId: stores.platformStoreId,
          currency: stores.currency,
          timezone: stores.timezone,
          installedAt: stores.installedAt,
          uninstalledAt: stores.uninstalledAt,
        })
        .from(stores),
      subscriptionsByStore(db, at),
      coverageByStore(db, coverageWindow),
      lastWebhookByStore(db),
      failedJobsByStore(db, failureWindow),
      orderBackfillByStore(db),
      ordersInPeriodByStore(db),
    ]);

  return rows.map((row) => {
    const facts: StoreFacts = {
      storeId: row.id,
      installedAt: toInstantFromDateOrNull(row.installedAt) as Instant,
      uninstalledAt: toInstantFromDateOrNull(row.uninstalledAt),
      subscription: subscriptions.get(row.id) ?? null,
      coverage: coverage.get(row.id) ?? null,
      lastWebhookAt: lastWebhook.get(row.id) ?? null,
      failedJobs: failedJobs.get(row.id) ?? 0,
      backfill: backfill.get(row.id) ?? null,
      ordersInPeriod: ordersInPeriod.get(row.id) ?? 0,
      // No integration records dashboard sessions yet. See docs/0009.
      dashboardSession: null,
    };

    return {
      storeId: row.id,
      platformStoreId: row.platformStoreId,
      currency: row.currency,
      timezone: row.timezone,
      installedAt: facts.installedAt,
      uninstalledAt: facts.uninstalledAt,
      subscription: facts.subscription,
      coverage: facts.coverage,
      lastWebhookAt: facts.lastWebhookAt,
      failedJobs: facts.failedJobs,
      backfill: facts.backfill,
      ordersInPeriod: facts.ordersInPeriod,
      health: storeHealth(facts, at),
      activation: activation(facts),
    };
  });
}

/** A summary with the platform it came from attached, once it has been merged. */
export interface PlatformStore extends StoreSummary {
  readonly platform: PlatformId;
}

export interface StoreFilter {
  readonly platform?: string | undefined;
  readonly status?: string | undefined;
  readonly plan?: string | undefined;
  readonly needsAttention?: boolean | undefined;
}

export const STORE_SORTS = ['orders', 'coverage', 'installed', 'store'] as const;
export type StoreSort = (typeof STORE_SORTS)[number];

export function isStoreSort(value: string): value is StoreSort {
  return (STORE_SORTS as readonly string[]).includes(value);
}

export function matchesFilter(store: PlatformStore, filter: StoreFilter): boolean {
  if (filter.platform !== undefined && store.platform !== filter.platform) return false;
  if (filter.status !== undefined && store.subscription?.status !== filter.status) return false;
  if (filter.plan !== undefined && store.subscription?.effectivePlanCode !== filter.plan) return false;
  if (filter.needsAttention === true && store.health.healthy) return false;
  return true;
}

/**
 * Sorting happens HERE, in application code, over the merged list.
 *
 * There is no cross-database ORDER BY to push this into — the platforms are
 * separate Postgres servers — so a database cursor cannot exist either. The
 * page is an offset into a list this process built.
 *
 * That is fine at the scale this portal is for and it is not fine forever. The
 * bound is stated rather than assumed: every store of every platform is loaded
 * to answer one page. At a few thousand stores that is a few hundred kilobytes
 * and a millisecond of sorting; at a hundred thousand it is a different design,
 * and the honest trigger for that redesign is this comment plus a slow page.
 */
export function sortStores(list: readonly PlatformStore[], sort: StoreSort): readonly PlatformStore[] {
  const sorted = [...list];
  switch (sort) {
    case 'orders':
      sorted.sort((a, b) => b.ordersInPeriod - a.ordersInPeriod);
      break;
    case 'coverage':
      // Unknown coverage sorts last rather than as zero: a store with no
      // revenue has not got bad coverage, and putting it at the top of a
      // "worst coverage" list buries the stores that really do.
      sorted.sort((a, b) => (a.coverage?.coverageBps ?? 10_001) - (b.coverage?.coverageBps ?? 10_001));
      break;
    case 'installed':
      sorted.sort((a, b) => b.installedAt.localeCompare(a.installedAt));
      break;
    case 'store':
      sorted.sort((a, b) => a.storeId.localeCompare(b.storeId));
      break;
  }
  return sorted;
}

export interface StorePage {
  readonly stores: readonly PlatformStore[];
  readonly total: number;
  /** Offset of the next page, or `null` at the end. */
  readonly nextCursor: number | null;
}

export function paginate(
  list: readonly PlatformStore[],
  cursor: number,
  limit: number,
): StorePage {
  const start = Math.max(0, cursor);
  const page = list.slice(start, start + limit);
  const next = start + limit;
  return { stores: page, total: list.length, nextCursor: next < list.length ? next : null };
}
