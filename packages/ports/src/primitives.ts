import type { Brand, Instant } from '@ghalla/contracts';

/**
 * An opaque resumption token. Never parsed outside the adapter that minted it.
 *
 * Deliberately not a page number and not a URL, because no numeric shape fits
 * every platform: one paginates orders with a page/total envelope and shipments
 * with a leaner one, another page-numbers orders with no total at all and
 * returns next/previous URLs for products. `nextCursor === null` is the only
 * termination signal all of them can express — and a string cursor is trivially
 * persistable, which is mandatory when a rate-limited backfill spans hours.
 */
export type Cursor = Brand<string, 'Cursor'>;

export interface Page<T> {
  readonly items: readonly T[];
  /** `null` means done. There is no `hasMore`, no `total`, no `pageCount`. */
  readonly nextCursor: Cursor | null;
}

/** A pointer to something on a platform. Never a payload. */
export interface EntityRef {
  readonly platformStoreId: string;
  /** ALWAYS a string. Platform ids routinely exceed `Number.MAX_SAFE_INTEGER`. */
  readonly platformId: string;
}

/** Half-open `[from, to)`, UTC — so a backfill that pages day by day composes without double counting. */
export interface DateRange {
  readonly fromInclusive: Instant;
  readonly toExclusive: Instant;
  /**
   * `'placed'`   — the first backfill, by placement date.
   * `'modified'` — incremental sync, and the reversal sweep. On a platform with
   *                no refund, return or shipment webhook, a modified-since scan
   *                is the only way a return is ever discovered.
   */
  readonly by: 'placed' | 'modified';
}

export function toCursor(raw: string): Cursor {
  return raw as Cursor;
}
