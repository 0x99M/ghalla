import { toInstant } from '@ghalla/contracts';
import type { Instant, PlatformId } from '@ghalla/contracts';
import { queryPlatforms } from '../platforms/registry';
import type { PlatformRegistry } from '../platforms/registry';
import { ingestionHealth, recentFailures, successRateBps } from './ingestion';
import type { FailedEvent, IngestionHealth } from './ingestion';
import { rangeToInstantWindow } from './window';
import type { Range } from './window';

/** Ingestion health across every platform — what `/api/health?range=` answers. */

export interface PlatformIngestion {
  readonly platform: PlatformId;
  readonly health: IngestionHealth;
  /** `null` when nothing arrived. A quiet platform has not achieved a perfect rate. */
  readonly successBps: number | null;
  readonly recentFailures: readonly FailedEvent[];
}

export interface IngestionReport {
  readonly range: Range;
  readonly platforms: readonly PlatformIngestion[];
  readonly missing: readonly { readonly platform: PlatformId; readonly reason: string }[];
  readonly totals: {
    readonly processed: number;
    readonly failed: number;
    readonly queueDepth: number;
    readonly stalled: number;
    readonly successBps: number | null;
  };
  readonly partial: boolean;
  readonly capturedAt: Instant;
}

export async function ingestionReport(
  registry: PlatformRegistry,
  range: Range,
  now: Date,
): Promise<IngestionReport> {
  const window = rangeToInstantWindow(range, now);

  const fan = await queryPlatforms(registry, async (handle) => {
    const [health, failures] = await Promise.all([
      ingestionHealth(handle.db, window, now),
      recentFailures(handle.db, 10),
    ]);
    return { health, failures };
  });

  const processed = fan.ok.reduce((sum, result) => sum + result.value.health.processed, 0);
  const failed = fan.ok.reduce((sum, result) => sum + result.value.health.failed, 0);

  return {
    range,
    platforms: fan.ok.map((result) => ({
      platform: result.platform,
      health: result.value.health,
      successBps: successRateBps(result.value.health.processed, result.value.health.failed),
      recentFailures: result.value.failures,
    })),
    missing: fan.failed.map((failure) => ({ platform: failure.platform, reason: failure.reason })),
    totals: {
      processed,
      failed,
      queueDepth: fan.ok.reduce((sum, result) => sum + result.value.health.pending, 0),
      stalled: fan.ok.reduce((sum, result) => sum + result.value.health.stalled, 0),
      // Summed then divided, never an average of per-platform rates.
      successBps: successRateBps(processed, failed),
    },
    partial: fan.partial,
    capturedAt: toInstant(fan.capturedAt),
  };
}
