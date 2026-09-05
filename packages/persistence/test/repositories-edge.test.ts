import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { and, eq, isNull } from 'drizzle-orm';
import path from 'node:path';
import { idFromString, toBps, toInstant, toMinor } from '@ghalla/contracts';
import type { CanonicalOrder, CanonicalOrderItem, CurrencyCode, Instant, StoreId } from '@ghalla/contracts';
import { computeOrderProfit } from '@ghalla/core';
import type { OrderProfitInput } from '@ghalla/core';
import * as schema from '../src/db/schema.js';
import { CostHistoryRepository } from '../src/repositories/cost-history.repository.js';
import { OrderProfitRepository } from '../src/repositories/order-profit.repository.js';
import { numericToMinor } from '../src/db/money.js';

/**
 * The paths a happy-path test never reaches: an order that is dead-lettered
 * rather than computed, an order whose money does not count at all, a targeted
 * recompute that matches nothing, and the cost correction the whole
 * slowly-changing-dimension design exists for.
 *
 * Against a real Postgres, in this process. Every one of these paths is guarded
 * by a CHECK constraint as well as by the repository, and a repository that
 * writes a row the database will not accept is a failure that only a real
 * database can show you.
 */
let client: PGlite;
let db: ReturnType<typeof drizzle<typeof schema>>;

const STORE = idFromString<'store'>('demo:1') as StoreId;
const FEE_STORE = idFromString<'store'>('demo:2') as StoreId;
const COST_STORE = idFromString<'store'>('demo:3') as StoreId;

const profitRepo = (): OrderProfitRepository => new OrderProfitRepository(db);
const costRepo = (): CostHistoryRepository => new CostHistoryRepository(db);

async function seedStore(id: StoreId, platformStoreId: string): Promise<void> {
  await db.insert(schema.stores).values({
    id,
    platform: 'demo',
    platformStoreId,
    currency: 'SAR',
    timezone: 'Asia/Riyadh',
    vatRateBps: 1_500,
    vatRegistered: true,
    installedAt: new Date('2026-01-01T00:00:00.000Z'),
  });
}

/** The ingested order row, which every profit row references. */
async function seedOrder(
  storeId: StoreId,
  platformOrderId: string,
  placedAt: string,
  currency: CurrencyCode = 'SAR',
): Promise<string> {
  const id = `${storeId}:${platformOrderId}`;
  await db.insert(schema.orders).values({
    id,
    storeId,
    platformOrderId,
    placedAt: new Date(placedAt),
    lifecycle: 'open',
    paymentState: 'paid',
    fulfillmentState: 'delivered',
    rawStatusLabel: 'delivered',
    fulfillmentMethod: 'carrier',
    currency,
    vatRateBps: 1_500,
    subtotalExVatMinor: '600.00',
    vatAmountMinor: '90.00',
    shippingChargedExVatMinor: '0.00',
    codFeeChargedExVatMinor: '0.00',
    totalIncVatMinor: '690.00',
  });
  return id;
}

interface InputOverrides {
  readonly isTest?: boolean;
  readonly currency?: CurrencyCode;
}

/** One SAR 600 card order with a costed line and a carrier leg. */
function buildInput(
  storeId: StoreId,
  orderId: string,
  feeRuleSetId: string,
  placedAt: string,
  overrides: InputOverrides = {},
): OrderProfitInput {
  const typedOrderId = idFromString<'order'>(orderId);
  const item: CanonicalOrderItem = {
    id: idFromString<'orderItem'>(`${orderId}#L1`),
    orderId: typedOrderId,
    platformLineId: 'L1',
    platformProductId: 'P1',
    platformVariantId: null,
    sku: 'SKU-1',
    productName: 'قميص',
    quantity: 1,
    unitPriceExVatMinor: toMinor(60_000),
    grossLineExVatMinor: toMinor(60_000),
    lineDiscountExVatMinor: toMinor(0),
    lineTotalExVatMinor: toMinor(60_000),
  };

  const order: CanonicalOrder = {
    id: typedOrderId,
    storeId,
    platformOrderId: orderId.split(':').slice(-1).join(''),
    placedAt: toInstant(placedAt),
    platformUpdatedAt: null,
    lifecycle: 'open',
    paymentState: 'paid',
    fulfillmentState: 'delivered',
    platformStatusId: null,
    rawStatusLabel: 'delivered',
    isTest: overrides.isTest ?? false,
    fulfillmentMethod: 'carrier',
    destination: { countryCode: 'SA', region: 'riyadh', city: 'riyadh' },
    currency: overrides.currency ?? 'SAR',
    vatRateBps: toBps(1_500),
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
    store: { storeId, currency: 'SAR', timezone: 'Asia/Riyadh', vatRegistered: true },
    order,
    items: [item],
    shipments: [
      {
        id: idFromString<'shipment'>(`${orderId}:S1`),
        orderId: typedOrderId,
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
        costHistoryId: idFromString<'costHistory'>('ch_seed'),
      },
    ],
    feeRuleSet: {
      id: idFromString<'feeRuleSet'>(feeRuleSetId),
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
          feeVatBps: toBps(1_500),
          ratesIncludeVat: false,
          source: 'merchant_entered',
        },
      ],
      cod: [],
      shippingFallback: [],
    },
  };
}

beforeAll(async () => {
  client = new PGlite();
  db = drizzle({ client, schema });
  await migrate(db, { migrationsFolder: path.resolve(import.meta.dirname, '..', 'drizzle') });

  await seedStore(STORE, '1');
  await seedStore(FEE_STORE, '2');
  await seedStore(COST_STORE, '3');
  await db.insert(schema.feeRuleSets).values([
    { id: 'frs_1', storeId: STORE, currency: 'SAR', effectiveFrom: new Date('2026-01-01T00:00:00.000Z') },
    { id: 'frs_fee', storeId: FEE_STORE, currency: 'SAR', effectiveFrom: new Date('2026-01-01T00:00:00.000Z') },
  ]);
}, 60_000);

afterAll(async () => {
  await client.close();
});

describe('an order the engine dead-letters', () => {
  it('still writes a row, so a dead letter is not mistaken for uncomputed work', async () => {
    const orderId = await seedOrder(STORE, '2001', '2026-03-01T18:30:00.000Z', 'AED');
    // A currency the store does not trade in is a caller defect, not a gap in
    // merchant data: the engine refuses to compute rather than guessing a rate.
    const result = computeOrderProfit(buildInput(STORE, orderId, 'frs_1', '2026-03-01T18:30:00.000Z', {
      currency: 'AED',
    }));
    expect(result.status).toBe('rejected');

    await profitRepo().save(result);

    const [row] = await db.select().from(schema.orderProfit).where(eq(schema.orderProfit.orderId, orderId));
    // Without this row the recompute sweep cannot tell an order it has already
    // refused from one it has never seen, and would pick it up forever.
    expect(row?.status).toBe('rejected');
    expect(row?.contributionMarginMinor).toBeNull();
    expect(row?.marginBps).toBeNull();
  });

  it('keeps the diagnostics, which are the only account of why it was refused', async () => {
    const orderId = `${STORE}:2001`;
    const [row] = await db.select().from(schema.orderProfit).where(eq(schema.orderProfit.orderId, orderId));
    // Codes, not prose: the merchant-facing copy is Arabic and comes from
    // translation, so an English sentence stored here would be unusable.
    expect(JSON.stringify(row?.diagnostics)).toContain('CURRENCY_MISMATCH');
  });

  it('writes no profit lines for an order that produced none', async () => {
    const lines = await db
      .select()
      .from(schema.orderProfitLines)
      .where(eq(schema.orderProfitLines.orderId, `${STORE}:2001`));
    expect(lines).toEqual([]);
  });

  it('is idempotent, because a dead letter arrives as many times as a good order', async () => {
    const orderId = `${STORE}:2001`;
    const result = computeOrderProfit(buildInput(STORE, orderId, 'frs_1', '2026-03-01T18:30:00.000Z', {
      currency: 'AED',
    }));
    await profitRepo().save(result);
    await profitRepo().save(result);

    const rows = await db.select().from(schema.orderProfit).where(eq(schema.orderProfit.orderId, orderId));
    expect(rows).toHaveLength(1);
  });

  it('clears the totals of an order that computed once and now rejects', async () => {
    // The order that matters most: a recompute under a new calc version finds a
    // defect the old one missed. Its stored margin is now known to be wrong, so
    // it must not survive the transition — a row reading `rejected` while still
    // carrying a contribution margin is a number the dashboard would show.
    //
    // Currently the save throws `order_profit_totals_iff_computed` instead: the
    // upsert flips the status and leaves every total behind. See the findings.
    const orderId = await seedOrder(STORE, '2002', '2026-03-01T18:30:00.000Z');
    const computed = computeOrderProfit(buildInput(STORE, orderId, 'frs_1', '2026-03-01T18:30:00.000Z'));
    expect(computed.status).toBe('computed');
    await profitRepo().save(computed);

    const rejected = computeOrderProfit(
      buildInput(STORE, orderId, 'frs_1', '2026-03-01T18:30:00.000Z', { currency: 'AED' }),
    );
    expect(rejected.status).toBe('rejected');
    await profitRepo().save(rejected);

    const [row] = await db.select().from(schema.orderProfit).where(eq(schema.orderProfit.orderId, orderId));
    expect(row?.status).toBe('rejected');
    expect(row?.contributionMarginMinor).toBeNull();
  });
});

describe('an order whose money does not count', () => {
  const ORDER = `${STORE}:2003`;

  beforeAll(async () => {
    await seedOrder(STORE, '2003', '2026-05-03T18:30:00.000Z');
    const result = computeOrderProfit(
      buildInput(STORE, ORDER, 'frs_1', '2026-05-03T18:30:00.000Z', { isTest: true }),
    );
    await profitRepo().save(result);
  });

  it('records the exclusion and its reason rather than dropping the order', async () => {
    const [row] = await db.select().from(schema.orderProfit).where(eq(schema.orderProfit.orderId, ORDER));
    // A merchant testing their checkout must not move the store's numbers, and
    // the row has to say why the order is missing from them.
    expect(row?.status).toBe('computed');
    expect(row?.recognitionKind).toBe('excluded');
    expect(row?.recognitionReason).toBe('test_order');
  });

  it('counts nothing at all, not even the costs it incurred', async () => {
    const [row] = await db.select().from(schema.orderProfit).where(eq(schema.orderProfit.orderId, ORDER));
    // A test order that shipped for real still has a carrier cost. Recognizing
    // it would turn every checkout test into a loss on the merchant's dashboard.
    expect(numericToMinor(row?.revenueExVatMinor ?? '')).toBe(0);
    expect(numericToMinor(row?.cogsMinor ?? '')).toBe(0);
    expect(numericToMinor(row?.outboundShippingCostMinor ?? '')).toBe(0);
    expect(numericToMinor(row?.contributionMarginMinor ?? '')).toBe(0);
    // A ratio to zero revenue is nothing, not zero per cent.
    expect(row?.marginBps).toBeNull();
  });

  it('writes no per-SKU lines, because no SKU earned or lost anything', async () => {
    const lines = await db
      .select()
      .from(schema.orderProfitLines)
      .where(eq(schema.orderProfitLines.orderId, ORDER));
    expect(lines).toEqual([]);
  });

  it('still dirties the store bucket, so a previously counted order is removed from it', async () => {
    const [bucket] = await db
      .select()
      .from(schema.dailyStoreRollup)
      .where(
        and(
          eq(schema.dailyStoreRollup.storeId, STORE),
          eq(schema.dailyStoreRollup.businessDate, '2026-05-03'),
        ),
      );
    expect(bucket?.dirty).toBe(true);
  });

  it('dirties no variant bucket, because it touched no variant', async () => {
    const buckets = await db
      .select()
      .from(schema.dailyVariantRollup)
      .where(
        and(
          eq(schema.dailyVariantRollup.storeId, STORE),
          eq(schema.dailyVariantRollup.businessDate, '2026-05-03'),
        ),
      );
    // Creating an empty per-variant bucket would put a product on the store's
    // loss-maker board for an order that is not supposed to exist.
    expect(buckets).toEqual([]);
  });
});

describe('republishing a fee rule set', () => {
  beforeAll(async () => {
    // Three orders across two business dates: the sweep works in buckets, not
    // orders, and the two counts differ.
    for (const [platformOrderId, placedAt] of [
      ['3001', '2026-03-01T18:30:00.000Z'],
      ['3002', '2026-03-01T19:00:00.000Z'],
      ['3003', '2026-04-02T18:30:00.000Z'],
    ] as const) {
      const orderId = await seedOrder(FEE_STORE, platformOrderId, placedAt);
      await profitRepo().save(computeOrderProfit(buildInput(FEE_STORE, orderId, 'frs_fee', placedAt)));
    }
    // Pretend the rollup sweep has since rebuilt every bucket.
    await db
      .update(schema.dailyStoreRollup)
      .set({ dirty: false })
      .where(eq(schema.dailyStoreRollup.storeId, FEE_STORE));
  });

  it('dirties one bucket per business date, not one per order', async () => {
    const dirtied = await profitRepo().markDirtyByFeeRuleSet(FEE_STORE, 'frs_fee');
    expect(dirtied).toBe(2);

    const buckets = await db
      .select()
      .from(schema.dailyStoreRollup)
      .where(eq(schema.dailyStoreRollup.storeId, FEE_STORE));
    expect(buckets.map((b) => b.businessDate).sort()).toEqual(['2026-03-01', '2026-04-02']);
    expect(buckets.every((b) => b.dirty)).toBe(true);
  });

  it('marks a bucket the sweep had already cleaned, rather than failing on it', async () => {
    // New rates invalidate a rebuilt bucket exactly as they invalidate a stale
    // one; a conflict here would leave the store showing the old fees forever.
    await db
      .update(schema.dailyStoreRollup)
      .set({ dirty: false })
      .where(eq(schema.dailyStoreRollup.storeId, FEE_STORE));

    expect(await profitRepo().markDirtyByFeeRuleSet(FEE_STORE, 'frs_fee')).toBe(2);
    const buckets = await db
      .select()
      .from(schema.dailyStoreRollup)
      .where(eq(schema.dailyStoreRollup.storeId, FEE_STORE));
    expect(buckets.every((b) => b.dirty)).toBe(true);
  });

  it('touches nothing when no order used that rule set', async () => {
    await db
      .update(schema.dailyStoreRollup)
      .set({ dirty: false })
      .where(eq(schema.dailyStoreRollup.storeId, FEE_STORE));

    // Publishing rates a store has never used must be a no-op, not a full
    // rebuild of every bucket it owns.
    expect(await profitRepo().markDirtyByFeeRuleSet(FEE_STORE, 'frs_never_used')).toBe(0);

    const buckets = await db
      .select()
      .from(schema.dailyStoreRollup)
      .where(eq(schema.dailyStoreRollup.storeId, FEE_STORE));
    expect(buckets.some((b) => b.dirty)).toBe(false);
  });
});

describe('recording a cost correction', () => {
  const JANUARY = toInstant('2026-01-01T00:00:00.000Z');
  const JUNE = toInstant('2026-06-01T00:00:00.000Z');

  const openRowsFor = async (productId: string): Promise<(typeof schema.costHistory.$inferSelect)[]> =>
    db
      .select()
      .from(schema.costHistory)
      .where(
        and(eq(schema.costHistory.storeId, COST_STORE), eq(schema.costHistory.platformProductId, productId)),
      );

  const entry = (
    id: string,
    productId: string,
    variantId: string | null,
    unitCostMinor: number,
    effectiveFrom: Instant,
  ) => ({
    id,
    storeId: COST_STORE,
    platformProductId: productId,
    platformVariantId: variantId,
    sku: null,
    unitCostMinor,
    source: 'merchant_manual' as const,
    effectiveFrom,
    note: null,
  });

  it('opens a window when the key has no cost yet', async () => {
    await costRepo().record(entry('ch_1', 'P1', null, 4_000, JANUARY));

    const rows = await openRowsFor('P1');
    expect(rows).toHaveLength(1);
    // Open, not closed at the moment it was written: the cost is true until the
    // merchant says otherwise.
    expect(rows[0]?.effectiveTo).toBeNull();
    expect(numericToMinor(rows[0]?.unitCostMinor ?? '')).toBe(4_000);
  });

  it('closes the old window at exactly the instant the new one opens', async () => {
    await costRepo().record(entry('ch_2', 'P1', null, 5_500, JUNE));

    const rows = await openRowsFor('P1');
    const closed = rows.find((r) => r.id === 'ch_1');
    const open = rows.find((r) => r.id === 'ch_2');
    // A gap would leave the key with no cost for the interval; an overlap would
    // return two rows, which the engine treats as a fatal DUPLICATE_COST_KEY.
    expect(closed?.effectiveTo?.toISOString()).toBe(JUNE);
    expect(open?.effectiveTo).toBeNull();
  });

  it('never rewrites the superseded cost, which is the whole point of the design', async () => {
    const [old] = (await openRowsFor('P1')).filter((r) => r.id === 'ch_1');
    // The brief's first non-negotiable: correcting a cost today may not change
    // what last quarter's orders were computed against.
    expect(numericToMinor(old?.unitCostMinor ?? '')).toBe(4_000);

    const march = await costRepo().resolveAsOf(
      COST_STORE,
      [{ platformProductId: 'P1', platformVariantId: null, sku: null }],
      toInstant('2026-03-01T00:00:00.000Z'),
    );
    expect(march[0]?.unitCostMinor).toBe(4_000);
    expect(march[0]?.costHistoryId).toBe('ch_1');

    const july = await costRepo().resolveAsOf(
      COST_STORE,
      [{ platformProductId: 'P1', platformVariantId: null, sku: null }],
      toInstant('2026-07-01T00:00:00.000Z'),
    );
    expect(july[0]?.unitCostMinor).toBe(5_500);
  });

  it('closes only the window for the key it was given', async () => {
    // A product-level row and a variant-level row are different keys, and SQL
    // treats every NULL as distinct — so matching the product-level one has to
    // be IS NULL rather than an equality, or the correction closes nothing.
    await costRepo().record(entry('ch_v1', 'P2', 'V1', 3_000, JANUARY));
    await costRepo().record(entry('ch_p2', 'P2', null, 2_000, JANUARY));
    await costRepo().record(entry('ch_p2b', 'P2', null, 2_500, JUNE));

    const rows = await openRowsFor('P2');
    const variantRow = rows.find((r) => r.id === 'ch_v1');
    const supersededProductRow = rows.find((r) => r.id === 'ch_p2');
    expect(variantRow?.effectiveTo).toBeNull();
    expect(supersededProductRow?.effectiveTo?.toISOString()).toBe(JUNE);
  });

  it('leaves the previous window open when the new row cannot be written', async () => {
    // The close and the insert are one transaction because half of it is worse
    // than neither: a closed window with nothing to replace it means the as-of
    // query returns no cost at all, and every order for that product silently
    // loses its COGS.
    await expect(costRepo().record(entry('ch_2', 'P1', null, 6_000, JUNE))).rejects.toThrow();

    const rows = await openRowsFor('P1');
    expect(rows.filter((r) => r.effectiveTo === null).map((r) => r.id)).toEqual(['ch_2']);
  });

  it('refuses to backdate a correction behind the window it would close', async () => {
    // Recording May after June would close the June window before it opened.
    // The database refuses the inverted window, and the transaction takes the
    // close down with it — so the history a merchant already has is intact.
    // What it is not is expressible: there is no way through this repository to
    // correct a cost as of a date earlier than the open row. See the findings.
    await costRepo().record(entry('ch_late', 'P5', null, 7_000, JUNE));
    await expect(
      costRepo().record(entry('ch_early', 'P5', null, 6_000, toInstant('2026-05-01T00:00:00.000Z'))),
    ).rejects.toThrow();

    const rows = await openRowsFor('P5');
    expect(rows.map((r) => r.id)).toEqual(['ch_late']);
    expect(rows[0]?.effectiveTo).toBeNull();
  });

  it('asks the database nothing when there are no keys to resolve', async () => {
    // An order with no items resolves no costs. A query with an empty IN list is
    // a scan of the whole table for a result that is known to be empty.
    expect(await costRepo().resolveAsOf(COST_STORE, [], JANUARY)).toEqual([]);
  });

  it('refuses a cost that arrives in major units instead of halalas', async () => {
    // SAR 12.50 typed as 12.5 rather than 1250 is a hundredfold understatement
    // of cost, which reads as a spectacularly profitable product.
    await expect(costRepo().record(entry('ch_frac', 'P3', null, 12.5, JANUARY))).rejects.toThrow();

    expect(await openRowsFor('P3')).toEqual([]);
  });

  it('resolves a history that overlaps itself to the most recent window', async () => {
    // `record` cannot produce this, but a bulk import or a hand-run correction
    // can, and then two windows cover one instant. The merchant's most recent
    // statement is the better guess of the two, and it has to be a stable
    // choice: resolving the same order to a different cost on a re-run would
    // change last quarter's profit on nothing but row order.
    await db.insert(schema.costHistory).values([
      {
        id: 'ch_overlap_old',
        storeId: COST_STORE,
        platformProductId: 'P9',
        platformVariantId: null,
        sku: null,
        unitCostMinor: '10.00',
        source: 'merchant_manual',
        effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
      },
      {
        id: 'ch_overlap_new',
        storeId: COST_STORE,
        platformProductId: 'P9',
        platformVariantId: null,
        sku: null,
        unitCostMinor: '11.00',
        source: 'merchant_manual',
        effectiveFrom: new Date('2026-02-01T00:00:00.000Z'),
      },
    ]);

    const resolved = await costRepo().resolveAsOf(
      COST_STORE,
      [{ platformProductId: 'P9', platformVariantId: null, sku: null }],
      toInstant('2026-03-01T00:00:00.000Z'),
    );
    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.costHistoryId).toBe('ch_overlap_new');
    expect(resolved[0]?.unitCostMinor).toBe(1_100);
  });
});

describe('cost coverage', () => {
  const AT = toInstant('2026-01-01T00:00:00.000Z');
  const COUNT_STORE = idFromString<'store'>('demo:4') as StoreId;

  beforeAll(async () => {
    await seedStore(COUNT_STORE, '4');
  });

  const record = async (
    id: string,
    productId: string,
    variantId: string | null,
    effectiveFrom = AT,
  ): Promise<void> => {
    await costRepo().record({
      id,
      storeId: COUNT_STORE,
      platformProductId: productId,
      platformVariantId: variantId,
      sku: null,
      unitCostMinor: 1_000,
      source: 'merchant_manual',
      effectiveFrom,
      note: null,
    });
  };

  it('counts nothing for a store that has costed nothing', async () => {
    expect(await costRepo().countKeysWithCost(COUNT_STORE)).toBe(0);
  });

  it('counts a product-level key and a variant-level key separately', async () => {
    await record('cnt_1', 'A', null);
    await record('cnt_2', 'A', 'V1');
    await record('cnt_3', 'B', null);
    // Coverage is per key the engine can resolve, and those are three distinct
    // keys even though two of them are the same product.
    expect(await costRepo().countKeysWithCost(COUNT_STORE)).toBe(3);
  });

  it('counts a corrected key once, not once per correction', async () => {
    await record('cnt_4', 'A', null, toInstant('2026-06-01T00:00:00.000Z'));
    // The history is two rows deep now; the merchant has still costed one key.
    expect(await costRepo().countKeysWithCost(COUNT_STORE)).toBe(3);
  });

  it('does not count a key whose cost was retired', async () => {
    await db
      .update(schema.costHistory)
      .set({ effectiveTo: new Date('2026-12-01T00:00:00.000Z') })
      .where(and(eq(schema.costHistory.storeId, COUNT_STORE), eq(schema.costHistory.platformProductId, 'B')));
    // Coverage answers "what do we know the cost of now". A window that has been
    // closed and not replaced is a gap, and reporting it as covered would send
    // the merchant hunting for a cost that is already there.
    expect(await costRepo().countKeysWithCost(COUNT_STORE)).toBe(2);
  });

  it('counts only the store it was asked about', async () => {
    const openEverywhere = await db
      .select()
      .from(schema.costHistory)
      .where(isNull(schema.costHistory.effectiveTo));
    // Every deployment is single-tenant per platform, but a store's coverage
    // must never be inflated by its neighbours in the same database.
    expect(openEverywhere.length).toBeGreaterThan(2);
    expect(await costRepo().countKeysWithCost(COUNT_STORE)).toBe(2);
  });
});

describe('the driver contract the codec rests on', () => {
  it('returns a Date for timestamptz and a plain string for date', async () => {
    const [row] = await db
      .select()
      .from(schema.orderProfit)
      .where(eq(schema.orderProfit.orderId, `${STORE}:2003`));
    // `src/db/codec.ts` is written against exactly this: a Date on the way out
    // of a timestamptz column, a YYYY-MM-DD string out of a date column. If the
    // driver ever changed either, the codec would cast rather than convert.
    expect(row?.computedAt).toBeInstanceOf(Date);
    expect(row?.businessDate).toBe('2026-05-03');
  });
});
