import { describe, expect, it, vi } from 'vitest';
import { AggregateCache, DEFAULT_TTL_MS, getAggregateCache } from '../src/lib/cache';

const NOW = 1_800_000_000_000;

describe('AggregateCache', () => {
  it('computes on a miss and serves the stored copy on a hit', async () => {
    const cache = new AggregateCache(1000);
    const compute = vi.fn(async () => 42);

    expect(await cache.read('k', NOW, compute)).toBe(42);
    expect(await cache.read('k', NOW + 999, compute)).toBe(42);
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it('returns the report unchanged, adding no timestamp of its own', async () => {
    // The report already carries `capturedAt` from when it was gathered, which
    // is the "last updated" a reader wants. Two stamps of one event would
    // leave them guessing which meant what.
    const cache = new AggregateCache(1000);
    await cache.read('k', NOW, async () => ({ capturedAt: 'gathered-at' }));
    expect(await cache.read('k', NOW + 500, async () => ({ capturedAt: 'never' }))).toEqual({
      capturedAt: 'gathered-at',
    });
  });

  it('recomputes once the entry expires', async () => {
    const cache = new AggregateCache(1000);
    await cache.read('k', NOW, async () => 1);
    expect(await cache.read('k', NOW + 1000, async () => 2)).toBe(2);
  });

  it('busts a key on demand, which is what the refresh button does', async () => {
    const cache = new AggregateCache(1000);
    await cache.read('k', NOW, async () => 1);
    cache.invalidate('k');
    expect(await cache.read('k', NOW, async () => 2)).toBe(2);
  });

  it('keeps keys apart and can be emptied', async () => {
    const cache = new AggregateCache();
    await cache.read('a', NOW, async () => 1);
    await cache.read('b', NOW, async () => 2);
    expect(cache.size).toBe(2);
    cache.clear();
    expect(cache.size).toBe(0);
  });

  it('defaults to sixty seconds', () => {
    expect(DEFAULT_TTL_MS).toBe(60_000);
  });

  it('is one instance per process, so a refresh in one request is seen by the next', () => {
    // Held on globalThis rather than in a module-level `let`, because Next
    // re-evaluates modules on hot reload and a plain singleton would forget
    // everything on each edit.
    expect(getAggregateCache()).toBe(getAggregateCache());
  });
});
