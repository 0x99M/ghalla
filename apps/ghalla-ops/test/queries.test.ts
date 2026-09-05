import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toInstant, toMinor } from '@ghalla/contracts';
import type { Minor } from '@ghalla/contracts';
import type { ListPrices, PlanCode } from '@ghalla/billing';
import { NOW, at, createIntegrationDb, seed } from './support/integration-db';
import type { IntegrationDb } from './support/integration-db';
import { platformCoverage, coverageByStore, storeCoverage, toCoverageBps } from '../src/lib/queries/coverage';
import {
  ingestionHealth,
  failedJobsByStore,
  lastWebhookByStore,
  orderBackfillByStore,
  recentFailures,
  successRateBps,
  unknownPaymentMethods,
} from '../src/lib/queries/ingestion';
import { ordersInPeriod, ordersInPeriodByStore, ordersIngested } from '../src/lib/queries/orders';
import { BILLED_STATUSES, mrr, statusCounts, subscriptionsByStore } from '../src/lib/queries/subscriptions';
import { COVERAGE_DAYS, trailingDays, trailingHours } from '../src/lib/queries/window';

/**
 * Every query in this file runs against a real Postgres carrying the real
 * integration schema. Nothing here is mocked, because the things most likely to
 * be wrong — a half-open range written closed, a LEFT JOIN condition in the
 * WHERE clause instead of the ON clause, a `filter (where …)` that does not
 * parse — are all things a mock agrees with cheerfully.
 */

let integration: IntegrationDb;
const AT = toInstant(NOW.toISOString());

/** Test prices, so the arithmetic is exercised with real numbers. */
const PRICES = {
  starter: toMinor(9_900),
  growth: toMinor(29_900),
  scale: toMinor(79_900),
  ads: toMinor(149_900),
  starter_annual: toMinor(99_000),
  growth_annual: toMinor(299_000),
  scale_annual: toMinor(799_000),
  ads_annual: toMinor(1_499_000),
} as const satisfies Record<PlanCode, Minor | null> as ListPrices;

beforeAll(async () => {
  integration = await createIntegrationDb();
  await seed(integration.client);
}, 60_000);

afterAll(async () => {
  await integration.close();
});

describe('statusCounts', () => {
  it('counts every subscription by status', async () => {
    expect(await statusCounts(integration.db)).toEqual({
      active: 3,
      trialing: 1,
      pastDue: 1,
      canceled: 1,
      expired: 0,
      subscriptions: 6,
    });
  });
});

describe('mrr', () => {
  it('EXCLUDES TRIALING, because a trial owes nothing', async () => {
    const result = await mrr(integration.db, AT, PRICES);
    // demo:1 growth, demo:2 starter, demo:3 scale, demo:7 on an unknown code.
    // Not demo:4 (trialing), not demo:5 (canceled).
    expect(result.billedStores).toBe(4);
    expect(result.listMrrMinor).toBe(9_900 + 29_900 + 79_900);
  });

  it('includes past_due, because the subscription still exists and still owes', async () => {
    const result = await mrr(integration.db, AT, PRICES);
    expect(result.byPlan.map((plan) => plan.planCode).sort()).toEqual(['growth', 'scale', 'starter']);
  });

  it('annualises before summing, so the total is not the sum of rounded parts', async () => {
    const result = await mrr(integration.db, AT, PRICES);
    expect(result.listArrMinor).toBe((9_900 + 29_900 + 79_900) * 12);
  });

  it('EXCLUDES A PLAN CODE THIS BUILD DOES NOT KNOW, and says so', async () => {
    // What a rollback to an older image looks like from here: a row naming a
    // plan the running code has never heard of. Silently dropping it would
    // make MRR fall for a reason nobody could find.
    const result = await mrr(integration.db, AT, PRICES);
    expect(result.unpricedPlans).toEqual([{ planCode: 'growth_v99', stores: 1 }]);
    expect(result.listMrrMinor).toBe(9_900 + 29_900 + 79_900);
  });

  it('reports every plan as unpriced while no list price is configured', async () => {
    // The default map has no prices yet, so every subscription is unpriced —
    // loudly wrong instead of quietly wrong.
    const result = await mrr(integration.db, AT);
    expect(result.listMrrMinor).toBe(0);
    expect(result.unpricedPlans.reduce((sum, plan) => sum + plan.stores, 0)).toBe(4);
  });

  it('derives the billed statuses from the domain predicate', () => {
    expect([...BILLED_STATUSES].sort()).toEqual(['active', 'past_due']);
  });
});

describe('subscriptionsByStore', () => {
  it('resolves the plan in force through the billing package', async () => {
    const byStore = await subscriptionsByStore(integration.db, AT);
    expect(byStore.get('demo:1')?.effectivePlanCode).toBe('growth');
    expect(byStore.get('demo:3')?.status).toBe('past_due');
    expect(byStore.size).toBe(6);
  });
});

describe('ordersInPeriod', () => {
  it('counts LIVE orders inside the subscription period, half-open at both ends', async () => {
    // demo:1 has orders at -5d, -4d, -1h (in), one backfilled (out), one at
    // -30d (before the period), one exactly at period start (IN) and one
    // exactly at period end (OUT).
    const count = await ordersInPeriod(integration.db, 'demo:1', {
      currentPeriodStart: toInstant(at(-10 * 24 * 3_600_000)),
      currentPeriodEnd: toInstant(at(20 * 24 * 3_600_000)),
    });
    expect(count).toBe(4);
  });

  it('agrees with the batch form, which is the same window expressed as a join', async () => {
    // Two implementations of "orders this period" is two screens disagreeing
    // about whether somebody is over their cap.
    const byStore = await ordersInPeriodByStore(integration.db);
    const subscriptions = await subscriptionsByStore(integration.db, AT);

    for (const [storeId, subscription] of subscriptions) {
      const single = await ordersInPeriod(integration.db, storeId, subscription);
      expect(byStore.get(storeId)).toBe(single);
    }
  });

  it('keeps a store with no orders in the list rather than dropping it', async () => {
    const byStore = await ordersInPeriodByStore(integration.db);
    expect(byStore.get('demo:5')).toBe(0);
    expect(byStore.size).toBe(6);
  });

  it('counts live ingestion in a window and ignores backfill', async () => {
    expect(await ordersIngested(integration.db, trailingHours(24, NOW))).toBe(1);
  });
});

describe('coverage', () => {
  it('is revenue-weighted: two sums divided once', async () => {
    const coverage = await storeCoverage(integration.db, 'demo:1', trailingDays(COVERAGE_DAYS, NOW));
    // 1000.00 + 500.00 revenue, 900.00 + 400.00 covered. The July bucket is
    // outside the window and must not drag the number down.
    expect(coverage.revenueExVatMinor).toBe(150_000);
    expect(coverage.coveredRevenueExVatMinor).toBe(130_000);
    expect(coverage.coverageBps).toBe(8_667);
  });

  it('aggregates the platform the same way, not as an average of store percentages', async () => {
    const coverage = await platformCoverage(integration.db, trailingDays(COVERAGE_DAYS, NOW));
    // demo:1 1500/1300, demo:2 200/150, demo:3 1000/100.
    expect(coverage.revenueExVatMinor).toBe(270_000);
    expect(coverage.coveredRevenueExVatMinor).toBe(155_000);
    expect(coverage.coverageBps).toBe(5_741);
  });

  it('reports the buckets awaiting rebuild, because those numbers will change', async () => {
    const coverage = await platformCoverage(integration.db, trailingDays(COVERAGE_DAYS, NOW));
    expect(coverage.dirtyBuckets).toBe(1);
  });

  it('gives a per-store map for the list', async () => {
    const byStore = await coverageByStore(integration.db, trailingDays(COVERAGE_DAYS, NOW));
    expect(byStore.get('demo:3')?.coverageBps).toBe(1_000);
    expect(byStore.has('demo:5')).toBe(false);
  });

  it('reads money as an exact decimal rather than a float', async () => {
    // The sums come back as numeric strings and go through the digit-wise
    // codec. `Number('1000.00') * 100` is the bug this avoids.
    const coverage = await storeCoverage(integration.db, 'demo:1', trailingDays(COVERAGE_DAYS, NOW));
    expect(Number.isSafeInteger(coverage.revenueExVatMinor)).toBe(true);
  });
});

describe('toCoverageBps', () => {
  it('is null when there is no revenue, because a ratio to nothing is nothing', () => {
    expect(toCoverageBps(toMinor(0), toMinor(0))).toBeNull();
    expect(toCoverageBps(toMinor(0), toMinor(-100))).toBeNull();
  });

  it('is exact integer arithmetic, multiplying before dividing', () => {
    expect(toCoverageBps(toMinor(1), toMinor(3))).toBe(3_333);
  });
});

describe('ingestionHealth', () => {
  it('counts outcomes over a window and the queue right now', async () => {
    const health = await ingestionHealth(integration.db, trailingHours(24, NOW), NOW);
    // demo:1's two processed events. demo:2's is three days old and outside.
    expect(health.processed).toBe(2);
    expect(health.failed).toBe(6);
    expect(health.pending).toBe(1);
    expect(health.processing).toBe(1);
  });

  it('sees a row held far longer than a worker should hold it', async () => {
    const health = await ingestionHealth(integration.db, trailingHours(24, NOW), NOW);
    expect(health.stalled).toBe(1);
  });

  it('windows the outcome counts but never the queue depth', async () => {
    // A queue depth over a window is meaningless, and unwindowing the outcome
    // counts would make a platform look unhealthy for a fault it recovered from
    // three weeks ago.
    const narrow = await ingestionHealth(integration.db, trailingHours(1, NOW), NOW);
    // One hour back: only the event at exactly -1h survives, which also pins
    // the window's lower bound as INCLUSIVE.
    expect(narrow.processed).toBe(1);
    // The pending event is three hours old and still counted, because the queue
    // is a snapshot of now and not a window.
    expect(narrow.pending).toBe(1);
  });
});

describe('successRateBps', () => {
  it('is null when nothing arrived, not 100%', () => {
    // A platform with no traffic has not achieved a perfect success rate, and
    // painting one green is how a silent integration goes unnoticed.
    expect(successRateBps(0, 0)).toBeNull();
    expect(successRateBps(3, 1)).toBe(7_500);
  });
});

describe('per-store ingestion facts', () => {
  it('finds each store´s most recent webhook', async () => {
    const byStore = await lastWebhookByStore(integration.db);
    expect(byStore.get('demo:1')).toBe(at(-3_600_000));
    expect(byStore.get('demo:2')).toBe(at(-3 * 24 * 3_600_000));
    expect(byStore.has('demo:4')).toBe(false);
  });

  it('counts failures per store inside the window', async () => {
    const byStore = await failedJobsByStore(integration.db, trailingHours(24, NOW));
    expect(byStore.get('demo:3')).toBe(6);
    expect(byStore.has('demo:1')).toBe(false);
  });

  it('reads only the ORDERS backfill', async () => {
    const byStore = await orderBackfillByStore(integration.db);
    expect(byStore.get('demo:1')?.status).toBe('complete');
    expect(byStore.get('demo:3')?.status).toBe('running');
  });

  it('lists recent failures newest first', async () => {
    const failures = await recentFailures(integration.db, 3);
    expect(failures).toHaveLength(3);
    expect(failures[0]?.receivedAt).toBe(at(-2 * 3_600_000));
  });
});

describe('unknownPaymentMethods', () => {
  it('ranks unmapped rails by how many orders they touch', async () => {
    const rows = await unknownPaymentMethods(integration.db, 10);
    expect(rows[0]).toEqual({
      storeId: 'demo:1',
      instrument: 'unknown',
      rawMethodLabel: 'tabby_installments',
      orders: 2,
    });
    expect(rows).toHaveLength(2);
  });

  it('leaves mapped rails out — a known card is not a queue item', async () => {
    const rows = await unknownPaymentMethods(integration.db, 10);
    expect(rows.some((row) => row.rawMethodLabel === 'mada')).toBe(false);
  });

  it('COUNTS ORDERS, NOT PAYMENT LEGS', async () => {
    // demo:3's single order settled in two captures on the same unmapped rail.
    // `count(*)` over `order_payments` would report two, ranking a rail by how
    // often it is split rather than by how much of the business uses it.
    const rows = await unknownPaymentMethods(integration.db, 10);
    const cheque = rows.find((row) => row.rawMethodLabel === 'bank_cheque');
    expect(cheque?.orders).toBe(1);
  });

  it('excludes a test order, which is not evidence that a rail needs a fee rule', async () => {
    const rows = await unknownPaymentMethods(integration.db, 10);
    expect(rows.some((row) => row.rawMethodLabel === 'test_only_rail')).toBe(false);
  });
});
