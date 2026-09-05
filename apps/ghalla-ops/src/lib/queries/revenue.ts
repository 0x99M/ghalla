import { toInstant, toMinor } from '@ghalla/contracts';
import type { Instant, Minor, PlatformId } from '@ghalla/contracts';
import { toMonthlyRate } from '@ghalla/billing';
import { queryPlatforms } from '../platforms/registry';
import type { PlatformRegistry } from '../platforms/registry';
import { mrr } from './subscriptions';
import type { MrrBreakdown } from './subscriptions';
import type { Range } from './window';

/**
 * Revenue, which today means LIST MRR right now.
 *
 * The range parameter is accepted and echoed back rather than ignored: MRR over
 * time is a question about the past, integration databases hold only the
 * present, and the series therefore arrives with the snapshot job. Reporting
 * `series: null` with the reason beside it is the difference between "not built
 * yet" and "there is no revenue history", and a chart that silently drew
 * nothing would say the second.
 */

export interface RevenueReport {
  readonly listMrrMinor: Minor;
  readonly listArrMinor: Minor;
  readonly billedStores: number;
  readonly unknownPlanSubscriptions: number;
  readonly byPlatform: readonly { readonly platform: PlatformId; readonly mrr: MrrBreakdown }[];
  readonly missing: readonly { readonly platform: PlatformId; readonly reason: string }[];
  /** Point-in-time history. `null` until the snapshot job writes `platform_snapshot`. */
  readonly series: null;
  readonly seriesUnavailable: string;
  readonly range: Range;
  readonly partial: boolean;
  readonly capturedAt: Instant;
}

export async function revenue(
  registry: PlatformRegistry,
  range: Range,
  now: Date,
): Promise<RevenueReport> {
  const at = toInstant(now.toISOString());
  const fan = await queryPlatforms(registry, async (handle) => mrr(handle.db, at));

  // ARR summed and divided once. Adding per-platform MRR would round once per
  // platform — the same mistake as rounding once per store, one level up.
  const annualised = fan.ok.reduce((sum, result) => sum + result.value.listArrMinor, 0);

  return {
    listMrrMinor: toMinor(toMonthlyRate(annualised)),
    listArrMinor: toMinor(annualised),
    billedStores: fan.ok.reduce((sum, result) => sum + result.value.billedStores, 0),
    unknownPlanSubscriptions: fan.ok.reduce(
      (sum, result) => sum + result.value.unknownPlans.reduce((n, plan) => n + plan.stores, 0),
      0,
    ),
    byPlatform: fan.ok.map((result) => ({ platform: result.platform, mrr: result.value })),
    missing: fan.failed.map((failure) => ({ platform: failure.platform, reason: failure.reason })),
    series: null,
    seriesUnavailable:
      'MRR over time needs point-in-time history; it lands with the snapshot job that fills platform_snapshot',
    range,
    partial: fan.partial,
    capturedAt: toInstant(fan.capturedAt),
  };
}
