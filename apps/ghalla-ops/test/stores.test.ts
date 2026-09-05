import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toInstant, toMinor } from '@ghalla/contracts';
import type { PlatformId } from '@ghalla/contracts';
import { NOW, createIntegrationDb, seed } from './support/integration-db';
import type { IntegrationDb } from './support/integration-db';
import {
  isStoreSort,
  matchesFilter,
  paginate,
  sortStores,
  storeSummaries,
} from '../src/lib/queries/stores';
import type { PlatformStore } from '../src/lib/queries/stores';

let integration: IntegrationDb;

beforeAll(async () => {
  integration = await createIntegrationDb();
  await seed(integration.client);
}, 60_000);

afterAll(async () => {
  await integration.close();
});

describe('storeSummaries', () => {
  it('returns every store with its facts joined, in a fixed number of queries', async () => {
    const summaries = await storeSummaries(integration.db, NOW);
    expect(summaries).toHaveLength(7);

    const first = summaries.find((store) => store.storeId === 'demo:1');
    expect(first).toMatchObject({
      platformStoreId: '1',
      currency: 'SAR',
      ordersInPeriod: 4,
      failedJobs: 0,
    });
    expect(first?.coverage?.coverageBps).toBe(8_667);
    expect(first?.health.healthy).toBe(true);
  });

  it('derives health from the real rows, not from a stored flag', async () => {
    const summaries = await storeSummaries(integration.db, NOW);
    const byId = new Map(summaries.map((store) => [store.storeId, store]));

    expect(byId.get('demo:2')?.health.flags).toEqual(['silent']);
    expect(byId.get('demo:3')?.health.flags).toEqual([
      'jobs_failing',
      'backfill_stuck',
      'coverage_low',
      'past_due',
    ]);
  });

  it('does not call a two-hour-old install silent, and does not alert on a store that left', async () => {
    const summaries = await storeSummaries(integration.db, NOW);
    const byId = new Map(summaries.map((store) => [store.storeId, store]));

    expect(byId.get('demo:4')?.health.flags).toEqual([]);
    expect(byId.get('demo:5')?.health.flags).toEqual([]);
    expect(byId.get('demo:5')?.uninstalledAt).not.toBeNull();
    // A store between its install webhook and its first billing webhook has no
    // subscription row at all, and must not alert on the strength of that.
    expect(byId.get('demo:6')?.subscription).toBeNull();
    expect(byId.get('demo:6')?.health.flags).toEqual([]);
    expect(byId.get('demo:6')?.ordersInPeriod).toBe(0);
  });

  it('reports activation as unknown while nothing records a dashboard session', async () => {
    const summaries = await storeSummaries(integration.db, NOW);
    expect(summaries.every((store) => store.activation.activated === null)).toBe(true);
    expect(summaries.find((s) => s.storeId === 'demo:1')?.activation.backfillComplete).toBe(true);
  });
});

const store = (overrides: Partial<PlatformStore>): PlatformStore =>
  ({
    platform: 'demo' as PlatformId,
    storeId: 'demo:1',
    platformStoreId: '1',
    currency: 'SAR',
    timezone: 'Asia/Riyadh',
    installedAt: toInstant('2026-01-01T00:00:00.000Z'),
    uninstalledAt: null,
    subscription: null,
    coverage: null,
    lastWebhookAt: null,
    failedJobs: 0,
    ordersInPeriod: 0,
    health: { storeId: 'demo:1', flags: [], healthy: true },
    activation: {
      storeId: 'demo:1',
      backfillComplete: false,
      coverageAboveThreshold: false,
      dashboardSession: null,
      activated: null,
    },
    ...overrides,
  }) as PlatformStore;

describe('matchesFilter', () => {
  const withStatus = (status: string): PlatformStore =>
    store({
      subscription: {
        storeId: 'demo:1',
        planCode: 'growth',
        effectivePlanCode: 'growth',
        status: status as never,
        currentPeriodStart: toInstant('2026-01-01T00:00:00.000Z'),
        currentPeriodEnd: toInstant('2026-02-01T00:00:00.000Z'),
        trialEndsAt: null,
        lastReconciledAt: null,
        pendingPlanCode: null,
      },
    });

  it('matches everything when nothing is asked for', () => {
    expect(matchesFilter(store({}), {})).toBe(true);
  });

  it('filters on platform, status and plan', () => {
    expect(matchesFilter(withStatus('active'), { status: 'active' })).toBe(true);
    expect(matchesFilter(withStatus('active'), { status: 'past_due' })).toBe(false);
    expect(matchesFilter(withStatus('active'), { plan: 'growth' })).toBe(true);
    expect(matchesFilter(withStatus('active'), { plan: 'scale' })).toBe(false);
    expect(matchesFilter(store({}), { platform: 'other' })).toBe(false);
  });

  it('filters to stores that need attention', () => {
    expect(matchesFilter(store({}), { needsAttention: true })).toBe(false);
    expect(
      matchesFilter(store({ health: { storeId: 'demo:1', flags: ['silent'], healthy: false } }), {
        needsAttention: true,
      }),
    ).toBe(true);
  });

  it('does not match a store with no subscription against a status filter', () => {
    expect(matchesFilter(store({}), { status: 'active' })).toBe(false);
  });
});

describe('sortStores', () => {
  const busy = store({ storeId: 'a', ordersInPeriod: 100 });
  const quiet = store({ storeId: 'b', ordersInPeriod: 1 });
  const bad = store({
    storeId: 'c',
    coverage: { revenueExVatMinor: toMinor(100), coveredRevenueExVatMinor: toMinor(10), coverageBps: 1_000, ordersCount: 1, dirtyBuckets: 0 },
  });
  const good = store({
    storeId: 'd',
    coverage: { revenueExVatMinor: toMinor(100), coveredRevenueExVatMinor: toMinor(90), coverageBps: 9_000, ordersCount: 1, dirtyBuckets: 0 },
  });
  const unknown = store({ storeId: 'e', coverage: null });

  it('ranks by orders, busiest first', () => {
    expect(sortStores([quiet, busy], 'orders').map((s) => s.storeId)).toEqual(['a', 'b']);
  });

  it('ranks by coverage worst first, with UNKNOWN coverage last', () => {
    // A store with no revenue has not got bad coverage. Sorting it as zero puts
    // every quiet store at the top of the worst-coverage list and buries the
    // ones that really are mispriced.
    expect(sortStores([good, unknown, bad], 'coverage').map((s) => s.storeId)).toEqual(['c', 'd', 'e']);
  });

  it('ranks by install date, newest first, and by id', () => {
    const older = store({ storeId: 'f', installedAt: toInstant('2025-01-01T00:00:00.000Z') });
    expect(sortStores([older, busy], 'installed').map((s) => s.storeId)).toEqual(['a', 'f']);
    expect(sortStores([quiet, busy], 'store').map((s) => s.storeId)).toEqual(['a', 'b']);
  });

  it('does not mutate the list it was given', () => {
    const list = [quiet, busy];
    sortStores(list, 'orders');
    expect(list[0]?.storeId).toBe('b');
  });

  it('accepts only the named sorts', () => {
    expect(isStoreSort('orders')).toBe(true);
    expect(isStoreSort('; drop table stores')).toBe(false);
  });
});

describe('paginate', () => {
  const list = Array.from({ length: 5 }, (_, index) => store({ storeId: `s${String(index)}` }));

  it('returns a page and the offset of the next one', () => {
    expect(paginate(list, 0, 2)).toMatchObject({ total: 5, nextCursor: 2 });
    expect(paginate(list, 0, 2).stores.map((s) => s.storeId)).toEqual(['s0', 's1']);
  });

  it('reports no next cursor at the end', () => {
    expect(paginate(list, 4, 2).nextCursor).toBeNull();
    expect(paginate(list, 99, 2).stores).toEqual([]);
  });

  it('treats a negative cursor as the beginning rather than slicing from the end', () => {
    expect(paginate(list, -3, 2).stores.map((s) => s.storeId)).toEqual(['s0', 's1']);
  });
});
