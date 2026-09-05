import process from 'node:process';
import { createDb, createPool } from '../pool.js';
import type { Database } from '../pool.js';
import {
  costHistory,
  feeRuleSets,
  gatewayFeeRules,
  codFeeRules,
  orderItems,
  orderPayments,
  orders,
  products,
  shipments,
  shippingFallbackRules,
  stores,
} from '../schema.js';

/**
 * A deterministic store to verify a release against.
 *
 * Every id and every amount is fixed, so the same seed produces the same rows
 * on every run — which is what lets the staging smoke test assert an exact
 * contribution margin rather than "a number appeared". A seed with a random
 * component can only ever check that something happened.
 *
 * The orders are chosen to exercise the shapes that actually break: a plain
 * prepaid sale, a refused cash-on-delivery parcel, and an order with no cost
 * data. If a release regresses any of the three, the margin moves and the smoke
 * test says so.
 */
export const SEED_STORE_ID = 'demo:1';
export const SEED_FEE_RULE_SET_ID = 'demo:frs:1';

/** What the smoke test asserts. Update deliberately, never to make a test pass. */
export const SEED_EXPECTATIONS = {
  storeId: SEED_STORE_ID,
  orderCount: 3,
  /** A straightforward prepaid card sale. */
  prepaid: { orderId: 'demo:1:1001', contributionMarginMinor: 9_210 },
  /** A refused COD parcel: two shipping legs, no revenue, goods back on the shelf. */
  refusedCod: { orderId: 'demo:1:1002', contributionMarginMinor: -4_400 },
  /** No cost recorded, so the margin is a bound rather than a number. */
  uncosted: { orderId: 'demo:1:1003', confidenceLevel: 'incomplete' },
} as const;

const at = (iso: string): Date => new Date(iso);

export async function seedDemoStore(db: Database): Promise<void> {
  await db.insert(stores).values({
    id: SEED_STORE_ID,
    platform: 'demo',
    platformStoreId: '1',
    currency: 'SAR',
    timezone: 'Asia/Riyadh',
    vatRateBps: 1_500,
    vatRegistered: true,
    installedAt: at('2026-01-01T00:00:00.000Z'),
  });

  await db.insert(feeRuleSets).values({
    id: SEED_FEE_RULE_SET_ID,
    storeId: SEED_STORE_ID,
    currency: 'SAR',
    effectiveFrom: at('2026-01-01T00:00:00.000Z'),
    note: 'Seeded demo rates',
  });

  await db.insert(gatewayFeeRules).values([
    {
      id: 'demo:gfr:mada',
      feeRuleSetId: SEED_FEE_RULE_SET_ID,
      instrument: 'card',
      scheme: 'mada',
      provider: null,
      percentBps: 100,
      fixedMinor: '0.00',
      minFeeMinor: null,
      // Domestic debit is capped per transaction.
      maxFeeMinor: '200.00',
      feeVatBps: 1_500,
      source: 'default_table',
    },
    {
      id: 'demo:gfr:visa',
      feeRuleSetId: SEED_FEE_RULE_SET_ID,
      instrument: 'card',
      scheme: 'visa',
      provider: null,
      percentBps: 275,
      fixedMinor: '1.00',
      minFeeMinor: null,
      maxFeeMinor: null,
      feeVatBps: 1_500,
      source: 'default_table',
    },
  ]);

  await db.insert(codFeeRules).values({
    id: 'demo:cfr:any',
    feeRuleSetId: SEED_FEE_RULE_SET_ID,
    carrier: null,
    percentBps: 200,
    fixedMinor: '8.00',
    minFeeMinor: null,
    maxFeeMinor: null,
    feeVatBps: 1_500,
    source: 'default_table',
  });

  // A single blended per-shipment number: the row a merchant creates at
  // onboarding, before anyone asks them for a rate card.
  await db.insert(shippingFallbackRules).values({
    id: 'demo:sfr:any',
    feeRuleSetId: SEED_FEE_RULE_SET_ID,
    countryCode: null,
    region: null,
    carrier: null,
    direction: 'any',
    costMinor: '22.00',
  });

  await db.insert(products).values([
    {
      storeId: SEED_STORE_ID,
      platformProductId: 'P1',
      sku: 'SKU-1',
      productName: 'عباية كلاسيكية',
      platformCostMinor: '240.00',
      listPriceExVatMinor: '400.00',
      active: true,
    },
    {
      storeId: SEED_STORE_ID,
      platformProductId: 'P2',
      sku: 'SKU-2',
      productName: 'شماغ قطني',
      platformCostMinor: null,
      listPriceExVatMinor: '300.00',
      active: true,
    },
  ]);

  await db.insert(costHistory).values({
    id: 'demo:ch:P1',
    storeId: SEED_STORE_ID,
    platformProductId: 'P1',
    platformVariantId: null,
    sku: 'SKU-1',
    unitCostMinor: '240.00',
    source: 'merchant_manual',
    effectiveFrom: at('2026-01-01T00:00:00.000Z'),
    effectiveTo: null,
    supersedesId: null,
    note: 'Seeded',
  });
  // P2 deliberately has NO cost row. That is the day-one state of every install,
  // and the order below must report `incomplete` rather than 100% margin.

  const order = (
    id: string,
    over: Partial<typeof orders.$inferInsert>,
  ): typeof orders.$inferInsert => ({
    id,
    storeId: SEED_STORE_ID,
    platformOrderId: id.split(':').at(-1) ?? id,
    placedAt: at('2026-03-01T18:30:00.000Z'),
    lifecycle: 'open',
    paymentState: 'paid',
    fulfillmentState: 'delivered',
    rawStatusLabel: 'delivered',
    isTest: false,
    fulfillmentMethod: 'carrier',
    destinationCountryCode: 'SA',
    destinationRegion: 'riyadh',
    destinationCity: 'riyadh',
    currency: 'SAR',
    vatRateBps: 1_500,
    subtotalExVatMinor: '0.00',
    vatAmountMinor: '0.00',
    shippingChargedExVatMinor: '0.00',
    codFeeChargedExVatMinor: '0.00',
    totalIncVatMinor: '0.00',
    ...over,
  });

  await db.insert(orders).values([
    order('demo:1:1001', {
      subtotalExVatMinor: '600.00',
      vatAmountMinor: '90.00',
      totalIncVatMinor: '690.00',
    }),
    order('demo:1:1002', {
      paymentState: 'unpaid',
      fulfillmentState: 'rto',
      rawStatusLabel: 'returned',
      subtotalExVatMinor: '300.00',
      vatAmountMinor: '45.00',
      totalIncVatMinor: '345.00',
    }),
    order('demo:1:1003', {
      subtotalExVatMinor: '300.00',
      vatAmountMinor: '45.00',
      totalIncVatMinor: '345.00',
    }),
  ]);

  await db.insert(orderItems).values([
    {
      id: 'demo:1:1001#L1',
      orderId: 'demo:1:1001',
      storeId: SEED_STORE_ID,
      platformLineId: 'L1',
      platformProductId: 'P1',
      platformVariantId: null,
      sku: 'SKU-1',
      productName: 'عباية كلاسيكية',
      quantity: 2,
      unitPriceExVatMinor: '300.00',
      grossLineExVatMinor: '600.00',
      lineDiscountExVatMinor: '0.00',
      lineTotalExVatMinor: '600.00',
      costAtTimeMinor: '240.00',
      costSource: 'merchant_manual',
      costHistoryId: 'demo:ch:P1',
    },
    {
      id: 'demo:1:1002#L1',
      orderId: 'demo:1:1002',
      storeId: SEED_STORE_ID,
      platformLineId: 'L1',
      platformProductId: 'P1',
      platformVariantId: null,
      sku: 'SKU-1',
      productName: 'عباية كلاسيكية',
      quantity: 1,
      unitPriceExVatMinor: '300.00',
      grossLineExVatMinor: '300.00',
      lineDiscountExVatMinor: '0.00',
      lineTotalExVatMinor: '300.00',
      costAtTimeMinor: '240.00',
      costSource: 'merchant_manual',
      costHistoryId: 'demo:ch:P1',
    },
    {
      id: 'demo:1:1003#L1',
      orderId: 'demo:1:1003',
      storeId: SEED_STORE_ID,
      platformLineId: 'L1',
      platformProductId: 'P2',
      platformVariantId: null,
      sku: 'SKU-2',
      productName: 'شماغ قطني',
      quantity: 1,
      unitPriceExVatMinor: '300.00',
      grossLineExVatMinor: '300.00',
      lineDiscountExVatMinor: '0.00',
      lineTotalExVatMinor: '300.00',
      costAtTimeMinor: null,
      costSource: 'none',
      costHistoryId: null,
    },
  ]);

  await db.insert(orderPayments).values([
    {
      id: 'demo:1:1001#pay0',
      orderId: 'demo:1:1001',
      legIndex: 0,
      instrument: 'card',
      scheme: 'mada',
      wallet: null,
      provider: null,
      rawMethodLabel: 'mada',
      state: 'captured',
      amountGrossMinor: '690.00',
      transactionRef: 'demo_txn_1001',
    },
    {
      id: 'demo:1:1002#pay0',
      orderId: 'demo:1:1002',
      legIndex: 0,
      instrument: 'cod',
      scheme: null,
      wallet: null,
      provider: null,
      rawMethodLabel: 'cash_on_delivery',
      // Never captured: the parcel came back, so no cash was ever handled.
      state: 'pending',
      amountGrossMinor: '345.00',
      transactionRef: null,
    },
    {
      id: 'demo:1:1003#pay0',
      orderId: 'demo:1:1003',
      legIndex: 0,
      instrument: 'card',
      scheme: 'mada',
      wallet: null,
      provider: null,
      rawMethodLabel: 'mada',
      state: 'captured',
      amountGrossMinor: '345.00',
      transactionRef: 'demo_txn_1003',
    },
  ]);

  await db.insert(shipments).values([
    {
      id: 'demo:1:S1',
      orderId: 'demo:1:1001',
      storeId: SEED_STORE_ID,
      platformShipmentId: 'S1',
      direction: 'outbound',
      status: 'delivered',
      carrier: 'demo_courier',
      rawCarrierLabel: 'Demo Courier',
      carrierCostMinor: '21.00',
    },
    {
      id: 'demo:1:S2',
      orderId: 'demo:1:1002',
      storeId: SEED_STORE_ID,
      platformShipmentId: 'S2',
      direction: 'outbound',
      status: 'returned_to_origin',
      carrier: 'demo_courier',
      rawCarrierLabel: 'Demo Courier',
      carrierCostMinor: '22.00',
    },
    {
      id: 'demo:1:S3',
      orderId: 'demo:1:1002',
      storeId: SEED_STORE_ID,
      platformShipmentId: 'S3',
      direction: 'return',
      status: 'returned_to_origin',
      carrier: 'demo_courier',
      rawCarrierLabel: 'Demo Courier',
      carrierCostMinor: '22.00',
    },
    {
      id: 'demo:1:S4',
      orderId: 'demo:1:1003',
      storeId: SEED_STORE_ID,
      platformShipmentId: 'S4',
      direction: 'outbound',
      status: 'delivered',
      carrier: 'demo_courier',
      rawCarrierLabel: 'Demo Courier',
      carrierCostMinor: '21.00',
    },
  ]);
}

async function main(): Promise<void> {
  const databaseUrl = process.env['DATABASE_URL'];
  if (databaseUrl === undefined || databaseUrl === '') throw new Error('DATABASE_URL is not defined');

  const pool = createPool({ databaseUrl, max: 1 });
  try {
    await seedDemoStore(createDb(pool));
    console.log(`Seeded store ${SEED_STORE_ID} with ${String(SEED_EXPECTATIONS.orderCount)} orders`);
  } finally {
    await pool.end();
  }
}

if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
