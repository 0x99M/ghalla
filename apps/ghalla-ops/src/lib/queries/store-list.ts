import { toInstant } from '@ghalla/contracts';
import type { Instant, PlatformId } from '@ghalla/contracts';
import { queryPlatforms } from '../platforms/registry';
import type { PlatformRegistry } from '../platforms/registry';
import { matchesFilter, paginate, sortStores, storeSummaries } from './stores';
import type { PlatformStore, StoreFilter, StoreSort } from './stores';

/**
 * The store list, merged across platforms.
 *
 * Filtering and sorting happen after the merge, in application code, because
 * there is no cross-database ORDER BY to push them into — the platforms are
 * separate Postgres servers. See `sortStores` for the bound that puts on this.
 */

export interface StoreListQuery {
  readonly filter: StoreFilter;
  readonly sort: StoreSort;
  readonly cursor: number;
  readonly limit: number;
}

export interface StoreListResult {
  readonly stores: readonly PlatformStore[];
  readonly total: number;
  readonly nextCursor: number | null;
  readonly missing: readonly { readonly platform: PlatformId; readonly reason: string }[];
  readonly partial: boolean;
  readonly capturedAt: Instant;
}

export async function storeList(
  registry: PlatformRegistry,
  query: StoreListQuery,
  now: Date,
): Promise<StoreListResult> {
  const fan = await queryPlatforms(registry, async (handle) => {
    const summaries = await storeSummaries(handle.db, now);
    return summaries.map((summary) => ({ ...summary, platform: handle.platform }));
  });

  const merged = fan.ok.flatMap((result) => result.value);
  const filtered = merged.filter((store) => matchesFilter(store, query.filter));
  const page = paginate(sortStores(filtered, query.sort), query.cursor, query.limit);

  return {
    stores: page.stores,
    total: page.total,
    nextCursor: page.nextCursor,
    missing: fan.failed.map((failure) => ({ platform: failure.platform, reason: failure.reason })),
    // A filtered count from a partial read is a number with a platform missing
    // from it, so the flag travels with it rather than being inferred.
    partial: fan.partial,
    capturedAt: toInstant(fan.capturedAt),
  };
}
