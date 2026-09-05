/**
 * A 60-second in-process cache for the expensive aggregates.
 *
 * The brief calls for Redis with a manual refresh that busts the key. We run no
 * Redis — docs/0006 — and this is the case where a shared cache buys least: one
 * operator, one service, a 60-second TTL over numbers that are already a
 * snapshot of a moment.
 *
 * The limitation is real and worth stating rather than discovering. If the
 * portal is ever run with more than one instance, the refresh button clears the
 * instance that served the click and the others expire a minute later. For a
 * 60-second TTL on an internal dashboard that is a shrug; for anything a
 * decision is made on within that minute, it would not be.
 *
 * The cache adds NO timestamp of its own. Every report it holds already carries
 * a `capturedAt` from the moment it was gathered, which is exactly the "last
 * updated" the design asks for — a cached hit correctly reports when the
 * numbers were collected rather than when they were handed over. A second
 * stamp beside it would be two timestamps of one event, and a reader would have
 * to guess which meant what.
 */

interface Entry<T> {
  readonly value: T;
  readonly expiresAt: number;
}

export const DEFAULT_TTL_MS = 60_000;

export class AggregateCache {
  private readonly entries = new Map<string, Entry<unknown>>();
  private readonly ttlMs: number;

  constructor(ttlMs: number = DEFAULT_TTL_MS) {
    this.ttlMs = ttlMs;
  }

  /**
   * Computes on a miss, returns the stored copy on a hit.
   *
   * Deliberately NOT de-duplicating concurrent misses. One operator does not
   * produce a thundering herd, and the machinery to collapse in-flight
   * computations is machinery that can deadlock a page — a worse failure than
   * running the same query twice in the same second.
   */
  async read<T>(key: string, now: number, compute: () => Promise<T>): Promise<T> {
    const entry = this.entries.get(key);
    if (entry !== undefined && entry.expiresAt > now) return entry.value as T;

    const value = await compute();
    this.entries.set(key, { value, expiresAt: now + this.ttlMs });
    return value;
  }

  /** What the refresh button calls. */
  invalidate(key: string): void {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}

const CACHE_KEY = Symbol.for('ghalla.ops.aggregateCache');

interface Holder {
  [CACHE_KEY]?: AggregateCache;
}

export function getAggregateCache(): AggregateCache {
  const holder = globalThis as Holder;
  holder[CACHE_KEY] ??= new AggregateCache();
  return holder[CACHE_KEY];
}
