import { toInstant, toMinor } from '@ghalla/contracts';
import type { Instant, Minor, PlatformId } from '@ghalla/contracts';
import { toMonthlyRate } from '@ghalla/billing';
import { queryPlatforms } from '../platforms/registry';
import type { PlatformRegistry } from '../platforms/registry';
import type { ReadOnlyDatabase } from '../platforms/read-only';
import { platformCoverage } from './coverage';
import type { Coverage } from './coverage';
import { ingestionHealth, successRateBps } from './ingestion';
import type { IngestionHealth } from './ingestion';
import { ordersIngested } from './orders';
import { countStores } from './stores';
import { mrr, statusCounts } from './subscriptions';
import type { MrrBreakdown, StatusCounts } from './subscriptions';
import { COVERAGE_DAYS, trailingDays, trailingHours } from './window';

/**
 * The overview, per platform and then merged.
 *
 * Everything cross-platform in this file goes through `queryPlatforms`, which
 * settles every platform independently and reports the ones it could not read.
 * That is why the merged shape carries `partial` and `missing`: a total that
 * silently omits a platform looks authoritative and is wrong, and nobody
 * rechecks a figure that rendered fine.
 */

export interface PlatformOverview {
  readonly stores: number;
  readonly statuses: StatusCounts;
  readonly mrr: MrrBreakdown;
  readonly coverage: Coverage;
  readonly ingestion: IngestionHealth;
  readonly ordersIngested24h: number;
}

export async function platformOverview(db: ReadOnlyDatabase, now: Date): Promise<PlatformOverview> {
  const day = trailingHours(24, now);
  const [stores, statuses, revenue, coverage, ingestion, ordersIngested24h] = await Promise.all([
    // Counted from `stores`, the same table the store list pages over. Reading
    // it off the subscription count made the two screens disagree.
    countStores(db),
    statusCounts(db),
    mrr(db, toInstant(now.toISOString())),
    platformCoverage(db, trailingDays(COVERAGE_DAYS, now)),
    ingestionHealth(db, day, now),
    ordersIngested(db, day),
  ]);

  return {
    stores,
    statuses,
    mrr: revenue,
    coverage,
    ingestion,
    ordersIngested24h,
  };
}

export interface OverviewTotals {
  readonly stores: number;
  readonly active: number;
  readonly trialing: number;
  readonly pastDue: number;
  readonly listMrrMinor: Minor;
  readonly listArrMinor: Minor;
  readonly unpricedSubscriptions: number;
  readonly ordersIngested24h: number;
  readonly queueDepth: number;
  readonly stalledJobs: number;
  /** `null` when nothing arrived. A quiet platform has not achieved a perfect rate. */
  readonly webhookSuccessBps: number | null;
  readonly coverageBps: number | null;
}

export interface Overview {
  readonly totals: OverviewTotals;
  readonly platforms: readonly { readonly platform: PlatformId; readonly overview: PlatformOverview }[];
  /** Platforms that could not be read, with the reason. */
  readonly missing: readonly { readonly platform: PlatformId; readonly reason: string }[];
  readonly partial: boolean;
  readonly capturedAt: Instant;
}

export async function overview(registry: PlatformRegistry, now: Date): Promise<Overview> {
  const fan = await queryPlatforms(registry, async (handle) => platformOverview(handle.db, now));

  let stores = 0;
  let active = 0;
  let trialing = 0;
  let pastDue = 0;
  let annualised = 0;
  let unpriced = 0;
  let ordersIngested24h = 0;
  let queueDepth = 0;
  let stalledJobs = 0;
  let processed = 0;
  let failed = 0;
  let revenueMinor = 0;
  let coveredMinor = 0;

  for (const { value } of fan.ok) {
    stores += value.stores;
    active += value.statuses.active;
    trialing += value.statuses.trialing;
    pastDue += value.statuses.pastDue;
    // ARR summed, MRR divided once at the end. Summing per-platform MRR would
    // round once per platform, which is the same mistake as rounding once per
    // store, one level up.
    annualised += value.mrr.listArrMinor;
    unpriced += value.mrr.unpricedPlans.reduce((sum, plan) => sum + plan.stores, 0);
    ordersIngested24h += value.ordersIngested24h;
    queueDepth += value.ingestion.pending;
    stalledJobs += value.ingestion.stalled;
    processed += value.ingestion.processed;
    failed += value.ingestion.failed;
    // Coverage merges as its two terms and divides once, for the same reason it
    // is stored that way: an average of per-platform percentages is not the
    // percentage across platforms.
    revenueMinor += value.coverage.revenueExVatMinor;
    coveredMinor += value.coverage.coveredRevenueExVatMinor;
  }

  return {
    totals: {
      stores,
      active,
      trialing,
      pastDue,
      listMrrMinor: toMinor(toMonthlyRate(annualised)),
      listArrMinor: toMinor(annualised),
      unpricedSubscriptions: unpriced,
      ordersIngested24h,
      queueDepth,
      stalledJobs,
      webhookSuccessBps: successRateBps(processed, failed),
      coverageBps: revenueMinor <= 0 ? null : Math.round((coveredMinor * 10_000) / revenueMinor),
    },
    platforms: fan.ok.map((result) => ({ platform: result.platform, overview: result.value })),
    missing: fan.failed.map((failure) => ({ platform: failure.platform, reason: failure.reason })),
    partial: fan.partial,
    capturedAt: toInstant(fan.capturedAt),
  };
}
