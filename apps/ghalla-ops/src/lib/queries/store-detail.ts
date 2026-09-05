import { toInstant } from '@ghalla/contracts';
import type { Instant, PlatformId } from '@ghalla/contracts';
import type { PlatformRegistry } from '../platforms/registry';
import { describeCheck } from '../platforms/registry';
import { recentFailures } from './ingestion';
import type { FailedEvent } from './ingestion';
import { storeSummaries } from './stores';
import type { StoreSummary } from './stores';

/**
 * One store, in full — the page opened while investigating.
 *
 * NOT cached, deliberately. Everything else in the portal is a rollup that can
 * be a minute stale without anybody being misled; this is the screen somebody
 * opens because they think something is wrong with THIS store, usually right
 * after doing something about it. A cached answer there is worse than a slow
 * one: it shows the state before the fix and invites a second fix.
 */

export interface StoreDetail {
  readonly platform: PlatformId;
  readonly store: StoreSummary;
  readonly recentFailures: readonly FailedEvent[];
  readonly capturedAt: Instant;
}

export type StoreDetailResult =
  | { readonly kind: 'found'; readonly detail: StoreDetail }
  | { readonly kind: 'unknown_platform' }
  /** The platform is registered but could not be read. NOT the same as no such store. */
  | { readonly kind: 'unavailable'; readonly reason: string }
  | { readonly kind: 'not_found' };

export async function storeDetail(
  registry: PlatformRegistry,
  platform: string,
  storeId: string,
  now: Date,
): Promise<StoreDetailResult> {
  const handle = registry.get(platform);
  if (handle === null) return { kind: 'unknown_platform' };

  const check = await registry.verify(handle.platform);
  if (!check.reachable || check.problems.length > 0) {
    return { kind: 'unavailable', reason: describeCheck(check) };
  }

  const [summaries, failures] = await Promise.all([
    storeSummaries(handle.db, now),
    recentFailures(handle.db, 20),
  ]);

  const store = summaries.find((summary) => summary.storeId === storeId);
  if (store === undefined) return { kind: 'not_found' };

  return {
    kind: 'found',
    detail: {
      platform: handle.platform,
      store,
      recentFailures: failures.filter((failure) => failure.storeId === storeId),
      capturedAt: toInstant(now.toISOString()),
    },
  };
}
