import { filterByIdentifier } from './presentation';
import type { StoreIdentity } from './presentation';

/**
 * The "Jump to store" dialog's decisions, kept out of the component.
 *
 * The dialog searches by the identifiers we have — `platformStoreId`,
 * `storeId`, `platform` — through the same `filterByIdentifier` the Stores
 * screen uses, so "does this store match what I typed" has one answer on both
 * screens. What is decided HERE is the order of the matches and how many are
 * shown, and both are the kind of thing that is wrong quietly.
 */

/** Rows shown at once. A jump box is for finding one store, not for browsing. */
export const JUMP_LIMIT = 8;

/** One page of the stores API, and the most pages the dialog will read. */
export const JUMP_PAGE_LIMIT = 200;
export const JUMP_MAX_PAGES = 10;

/**
 * 0 — the id IS the query, 1 — the id starts with it, 2 — it merely contains
 * it. Exact first because the operator who pasted an id from a log wants that
 * row at the top and under their Enter key, not seventh behind the ids that
 * happen to share a prefix with it.
 */
function tier(store: StoreIdentity, needle: string): 0 | 1 | 2 {
  const ids = [store.platformStoreId.toLowerCase(), store.storeId.toLowerCase()];
  if (ids.some((id) => id === needle)) return 0;
  if (ids.some((id) => id.startsWith(needle))) return 1;
  return 2;
}

/**
 * The rows to show for a query: filtered, exact matches first, then prefix
 * matches, then the rest — each group keeping the order the API returned,
 * which is the list's sort (orders in the period, most first).
 *
 * An empty query shows the top of that same list: with nothing typed, the
 * busiest stores are the likeliest destination.
 */
export function rankJump<T extends StoreIdentity>(
  stores: readonly T[],
  query: string,
  limit: number = JUMP_LIMIT,
): readonly T[] {
  const needle = query.trim().toLowerCase();
  const matches = filterByIdentifier(stores, needle);
  if (needle === '') return matches.slice(0, limit);
  return matches
    .map((store, index) => ({ store, index, tier: tier(store, needle) }))
    .sort((a, b) => a.tier - b.tier || a.index - b.index)
    .slice(0, limit)
    .map((entry) => entry.store);
}

/**
 * Where the highlight goes after an arrow key. Clamped, not wrapped: a list of
 * eight is short enough that Down from the bottom doing nothing is less
 * surprising than it jumping to the top. An empty list has no highlight.
 */
export function moveHighlight(current: number, delta: number, length: number): number {
  if (length === 0) return -1;
  return Math.min(length - 1, Math.max(0, current + delta));
}
