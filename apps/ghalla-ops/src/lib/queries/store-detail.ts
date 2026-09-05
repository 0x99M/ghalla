import { toInstant } from '@ghalla/contracts';
import type { Instant, PlatformId } from '@ghalla/contracts';
import type { PlatformRegistry } from '../platforms/registry';
import { describeError } from '../errors';
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

  // Wrapped, because this is the ONE read path that does not go through
  // `queryPlatforms` and therefore has nothing catching a rejection for it.
  // The probe above is not enough on its own: successful probes are cached for
  // the life of the process, so a platform that was reachable at startup keeps
  // answering `reachable: true` while its database is refusing connections —
  // and the `unavailable` branch below would be unreachable for exactly the
  // outage it exists to report.
  let summaries: readonly StoreSummary[];
  let failures: readonly FailedEvent[];
  try {
    [summaries, failures] = await Promise.all([
      storeSummaries(handle.db, now),
      // The STORE's own failures. Narrowed in SQL — see `recentFailures`.
      recentFailures(handle.db, 20, storeId),
    ]);
  } catch (error) {
    return { kind: 'unavailable', reason: describeError(error) };
  }

  const store = summaries.find((summary) => summary.storeId === storeId);
  if (store === undefined) return { kind: 'not_found' };

  return {
    kind: 'found',
    detail: {
      platform: handle.platform,
      store,
      recentFailures: failures,
      capturedAt: toInstant(now.toISOString()),
    },
  };
}
