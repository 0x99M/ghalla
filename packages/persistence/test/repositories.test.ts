import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { and, eq } from 'drizzle-orm';
import path from 'node:path';
import { idFromString, toBps, toInstant, toMinor } from '@ghalla/contracts';
import type { CanonicalOrder, CanonicalOrderItem, StoreId } from '@ghalla/contracts';
import { computeOrderProfit } from '@ghalla/core';
import type { OrderProfitInput } from '@ghalla/core';
import * as schema from '../src/db/schema.js';
import { CostHistoryRepository } from '../src/repositories/cost-history.repository.js';
import { OrderProfitRepository } from '../src/repositories/order-profit.repository.js';
import { numericToMinor } from '../src/db/money.js';

let client: PGlite;
let db: ReturnType<typeof drizzle<typeof schema>>;

const STORE_ID = idFromString<'store'>('demo:1') as StoreId;
const ORDER_ID = idFromString<'order'>('demo:1:1001');

beforeAll(async () => {
  client = new PGlite();
  db = drizzle({ client, schema });
  await migrate(db, { migrationsFolder: path.resolve(import.meta.dirname, '..', 'drizzle') });
  await db.insert(schema.stores).values({
    id: STORE_ID,
    platform: 'demo',
    platformStoreId: '1',
    currency: 'SAR',
    timezone: 'Asia/Riyadh',
    vatRateBps: 1500,
    vatRegistered: true,
    installedAt: new Date('2026-01-01T00:00:00.000Z'),
  });
  await db.insert(schema.feeRuleSets).values({
    id: 'frs_1',
    storeId: STORE_ID,
    currency: 'SAR',
    effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
  });
  await db.insert(schema.orders).values({
    id: ORDER_ID,
    storeId: STORE_ID,
    platformOrderId: '1001',
    placedAt: new Date('2026-03-01T18:30:00.000Z'),
    lifecycle: 'open',
    paymentState: 'paid',
    fulfillmentState: 'delivered',
    rawStatusLabel: 'delivered',
    fulfillmentMethod: 'carrier',
    currency: 'SAR',
    vatRateBps: 1500,
    subtotalExVatMinor: '600.00',
    vatAmountMinor: '90.00',
    shippingChargedExVatMinor: '0.00',
    codFeeChargedExVatMinor: '0.00',
    totalIncVatMinor: '690.00',
  });
}, 60_000);

afterAll(async () => {
  await client.close();
});

describe('CostHistoryRepository', () => {
  const repo = (): CostHistoryRepository => new CostHistoryRepository(db);

  it('resolves the cost that was true when the order was placed, not the current one', async () => {
    // The brief's first non-negotiable: a merchant editing a cost today must not
    // silently change last quarter's profit.
    await db.insert(schema.costHistory).values([
      {
        id: 'ch_old',
        storeId: STORE_ID,
        platformProductId: 'P1',
        platformVariantId: null,
        sku: 'SKU-1',
        unitCostMinor: '40.00',
        source: 'merchant_manual',
        effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
        effectiveTo: new Date('2026-06-01T00:00:00.000Z'),
      },
      {
        id: 'ch_new',
        storeId: STORE_ID,
        platformProductId: 'P1',
        platformVariantId: null,
        sku: 'SKU-1',
        unitCostMinor: '55.00',
        source: 'merchant_manual',
        effectiveFrom: new Date('2026-06-01T00:00:00.000Z'),
        effectiveTo: null,
      },
    ]);

    const key = [{ platformProductId: 'P1', platformVariantId: null, sku: 'SKU-1' }];

    const atMarch = await repo().resolveAsOf(STORE_ID, key, toInstant('2026-03-01T18:30:00.000Z'));
    expect(atMarch[0]?.unitCostMinor).toBe(4_000);
    expect(atMarch[0]?.costHistoryId).toBe('ch_old');

    const atJuly = await repo().resolveAsOf(STORE_ID, key, toInstant('2026-07-01T00:00:00.000Z'));
    expect(atJuly[0]?.unitCostMinor).toBe(5_500);
    expect(atJuly[0]?.costHistoryId).toBe('ch_new');
  });

  it('treats the window as half-open, so the boundary instant belongs to the new row', async () => {
    const key = [{ platformProductId: 'P1', platformVariantId: null, sku: 'SKU-1' }];
    const atBoundary = await repo().resolveAsOf(STORE_ID, key, toInstant('2026-06-01T00:00:00.000Z'));
    expect(atBoundary[0]?.costHistoryId).toBe('ch_new');
  });

  it('falls back to SKU when a platform reports no variant on the order line', async () => {
    await db.insert(schema.costHistory).values({
      id: 'ch_sku',
      storeId: STORE_ID,
      platformProductId: 'P_OTHER',
      platformVariantId: 'V9',
      sku: 'SKU-ONLY',
      unitCostMinor: '12.34',
      source: 'merchant_bulk_import',
      effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
    });
    const resolved = await repo().resolveAsOf(
      STORE_ID,
      [{ platformProductId: 'P_UNKNOWN', platformVariantId: null, sku: 'SKU-ONLY' }],
      toInstant('2026-03-01T00:00:00.000Z'),
    );
    expect(resolved[0]?.unitCostMinor).toBe(1_234);
  });

  it('returns nothing rather than a guess when no cost covers the instant', async () => {
    const resolved = await repo().resolveAsOf(
      STORE_ID,
      [{ platformProductId: 'P1', platformVariantId: null, sku: 'SKU-1' }],
      toInstant('2025-01-01T00:00:00.000Z'),
    );
    // A miss must reach the engine as a miss: it contributes zero to COGS and
    // degrades confidence to `missing`, which is what keeps the order out of
    // loss-maker ranking.
    expect(resolved).toEqual([]);
  });
});

/** A whole order, so the engine and the repository are exercised together. */
function buildInput(): OrderProfitInput {
  const item = (n: number, ex: number): CanonicalOrderItem => ({
    id: idFromString<'orderItem'>(`${ORDER_ID}#L${String(n)}`),
    orderId: ORDER_ID,
    platformLineId: `L${String(n)}`,
    platformProductId: `P${String(n)}`,
    platformVariantId: null,
    sku: `SKU-${String(n)}`,
    productName: `منتج ${String(n)}`,
    quantity: 1,
    unitPriceExVatMinor: toMinor(ex),
    grossLineExVatMinor: toMinor(ex),
    lineDiscountExVatMinor: toMinor(0),
    lineTotalExVatMinor: toMinor(ex),
  });

  const order: CanonicalOrder = {
    id: ORDER_ID,
    storeId: STORE_ID,
    platformOrderId: '1001',
    placedAt: toInstant('2026-03-01T18:30:00.000Z'),
    platformUpdatedAt: null,
    lifecycle: 'open',
    paymentState: 'paid',
    fulfillmentState: 'delivered',
    platformStatusId: null,
    rawStatusLabel: 'delivered',
    isTest: false,
    fulfillmentMethod: 'carrier',
    destination: { countryCode: 'SA', region: 'riyadh', city: 'riyadh' },
    currency: 'SAR',
    vatRateBps: toBps(1500),
    subtotalExVatMinor: toMinor(60_000),
    vatAmountMinor: toMinor(9_000),
    shippingChargedExVatMinor: toMinor(0),
    codFeeChargedExVatMinor: toMinor(0),
    totalIncVatMinor: toMinor(69_000),
    discounts: [],
    payments: [
      {
        instrument: 'card',
        scheme: 'mada',
        wallet: null,
        provider: null,
        rawMethodLabel: 'mada',
        state: 'captured',
        amountGrossMinor: toMinor(69_000),
        transactionRef: null,
      },
    ],
    customerRef: null,
    attribution: null,
  };

  return {
    store: { storeId: STORE_ID, currency: 'SAR', timezone: 'Asia/Riyadh', vatRegistered: true },
    order,
    items: [item(1, 40_000), item(2, 20_000)],
    shipments: [
      {
        id: idFromString<'shipment'>('demo:1:S1'),
        orderId: ORDER_ID,
        platformShipmentId: 'S1',
        direction: 'outbound',
        status: 'delivered',
        carrier: 'demo_courier',
        rawCarrierLabel: 'Demo',
        carrierCostMinor: toMinor(2_100),
        lines: [],
        shippedAt: null,
        deliveredAt: null,
        platformUpdatedAt: null,
      },
    ],
    reversals: [],
    costs: [
      {
        platformProductId: 'P1',
        platformVariantId: null,
        sku: 'SKU-1',
        unitCostMinor: toMinor(24_000),
        source: 'merchant_manual',
        costHistoryId: idFromString<'costHistory'>('ch_old'),
      },
      {
        platformProductId: 'P2',
        platformVariantId: null,
        sku: 'SKU-2',
        unitCostMinor: toMinor(12_000),
        source: 'merchant_manual',
        costHistoryId: idFromString<'costHistory'>('ch_old'),
      },
    ],
    feeRuleSet: {
      id: idFromString<'feeRuleSet'>('frs_1'),
      currency: 'SAR',
      gateway: [
        {
          instrument: 'card',
          scheme: 'mada',
          provider: null,
          percentBps: toBps(100),
          fixedMinor: toMinor(0),
          minFeeMinor: null,
          maxFeeMinor: toMinor(20_000),
          feeVatBps: toBps(1500),
          ratesIncludeVat: false,
          source: 'merchant_entered',
        },
      ],
      cod: [],
      shippingFallback: [],
    },
  };
}

describe('OrderProfitRepository', () => {
  it('round-trips every money field through numeric(14,2) without losing a halala', async () => {
    const result = computeOrderProfit(buildInput());
    expect(result.status).toBe('computed');
    if (result.status !== 'computed') return;

    await new OrderProfitRepository(db).save(result);

    const [row] = await db
      .select()
      .from(schema.orderProfit)
      .where(eq(schema.orderProfit.orderId, ORDER_ID));

    expect(row).toBeDefined();
    // The column holds a decimal string; the domain holds an integer. The two
    // must describe the same money.
    expect(numericToMinor(row?.contributionMarginMinor ?? '0')).toBe(result.totals.contributionMarginMinor);
    expect(numericToMinor(row?.revenueExVatMinor ?? '0')).toBe(result.totals.revenueExVatMinor);
    expect(numericToMinor(row?.cogsMinor ?? '0')).toBe(result.totals.cogsMinor);
    expect(row?.marginBps).toBe(result.totals.marginBps);
    expect(row?.businessDate).toBe(result.businessDate);
    expect(row?.calcVersion).toBe(result.calcVersion);
  });

  it('keeps the per-SKU rows summing to the order, through the database', async () => {
    const lines = await db
      .select()
      .from(schema.orderProfitLines)
      .where(eq(schema.orderProfitLines.orderId, ORDER_ID));
    expect(lines).toHaveLength(2);

    const [order] = await db
      .select()
      .from(schema.orderProfit)
      .where(eq(schema.orderProfit.orderId, ORDER_ID));

    // The tie that matters most, re-checked after a serialize/deserialize round
    // trip: a halala lost in the column would show up here and nowhere else.
    const summed = lines.reduce((total, line) => total + numericToMinor(line.contributionMarginMinor), 0);
    expect(summed).toBe(numericToMinor(order?.contributionMarginMinor ?? '0'));
  });

  it('marks the ORDER’s bucket dirty, not today’s', async () => {
    const [bucket] = await db
      .select()
      .from(schema.dailyStoreRollup)
      .where(
        and(
          eq(schema.dailyStoreRollup.storeId, STORE_ID),
          eq(schema.dailyStoreRollup.businessDate, '2026-03-01'),
        ),
      );
    // A carrier cost that lands days later must invalidate the day the order was
    // placed. Marking today would leave the real bucket silently stale.
    expect(bucket?.dirty).toBe(true);
  });

  it('marks a variant bucket per product touched', async () => {
    const buckets = await db
      .select()
      .from(schema.dailyVariantRollup)
      .where(eq(schema.dailyVariantRollup.storeId, STORE_ID));
    expect(buckets.map((b) => b.platformProductId).sort()).toEqual(['P1', 'P2']);
    expect(buckets.every((b) => b.dirty)).toBe(true);
  });

  it('is idempotent: recomputing the same order replaces rather than accumulates', async () => {
    const result = computeOrderProfit(buildInput());
    await new OrderProfitRepository(db).save(result);
    await new OrderProfitRepository(db).save(result);

    const lines = await db
      .select()
      .from(schema.orderProfitLines)
      .where(eq(schema.orderProfitLines.orderId, ORDER_ID));
    // Webhook delivery is at-least-once, so this path runs many times per order.
    expect(lines).toHaveLength(2);
  });

  it('finds the orders a CALC_VERSION bump left behind', async () => {
    const stale = await new OrderProfitRepository(db).findStaleOrderIds(STORE_ID, 99, 10);
    expect(stale).toContain(ORDER_ID);
    const current = await new OrderProfitRepository(db).findStaleOrderIds(STORE_ID, 1, 10);
    expect(current).toEqual([]);
  });
});
