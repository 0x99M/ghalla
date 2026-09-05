import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { eq } from 'drizzle-orm';
import path from 'node:path';
import { idFromString, toBps, toInstant, toMinor } from '@ghalla/contracts';
import type {
  CanonicalOrder,
  CanonicalOrderItem,
  CanonicalShipment,
  CardScheme,
  CostSource,
  FeeRuleSetId,
  OrderId,
  PaymentBreakdown,
  PaymentInstrument,
  PaymentState,
  StoreId,
} from '@ghalla/contracts';
import { computeOrderProfit } from '@ghalla/core';
import type { CodFeeRule, GatewayFeeRule, OrderProfitInput, ShippingFallbackRule } from '@ghalla/core';
import * as schema from '../src/db/schema.js';
import { numericToMinor, numericToMinorOrNull } from '../src/db/money.js';
import {
  PROTECTED_ENVIRONMENTS,
  RefusedError,
  assertClearIsAllowed,
  clearAll,
  listTables,
} from '../src/db/clear.js';
import { SEED_EXPECTATIONS, SEED_FEE_RULE_SET_ID, SEED_STORE_ID, seedDemoStore } from '../src/db/seeds/demo-store.js';

/**
 * The clear → seed → verify cycle a release runs before it is allowed near a
 * merchant.
 *
 * Both halves are exercised against a real migrated Postgres — PGlite compiled
 * to WebAssembly, in this process — because most of what either one can get
 * wrong is a CHECK constraint. A seed that inserts a row the schema forbids is
 * a broken release gate, not a broken test fixture, and a clear command that
 * misses a table leaves the next run asserting against yesterday's money.
 */

/**
 * `clear.ts` and `demo-store.ts` are scripts: they open their own pool from
 * DATABASE_URL and close it again. Handing both the migrated PGlite database
 * instead lets the programs run end to end — argv guard, environment reading,
 * error handling and all — against real tables rather than a mock that would
 * only assert itself.
 */
const wiring = vi.hoisted(() => ({
  db: null as unknown,
  poolsEnded: 0,
}));

vi.mock('../src/db/pool.js', () => ({
  createPool: (): { end: () => Promise<void> } => ({
    end: (): Promise<void> => {
      wiring.poolsEnded += 1;
      return Promise.resolve();
    },
  }),
  createDb: (): unknown => wiring.db,
}));

let client: PGlite;
let db: ReturnType<typeof drizzle<typeof schema>>;

const MIGRATIONS = path.resolve(import.meta.dirname, '..', 'drizzle');
const CLEAR_SCRIPT = path.resolve(import.meta.dirname, '..', 'src', 'db', 'clear.ts');
const SEED_SCRIPT = path.resolve(import.meta.dirname, '..', 'src', 'db', 'seeds', 'demo-store.ts');

/**
 * Empties the database in raw SQL rather than through `clearAll`, so a test of
 * the clear command never depends on the clear command having worked.
 */
async function emptyEverything(): Promise<void> {
  await client.exec(`
    DO $$ DECLARE t text; BEGIN
      FOR t IN SELECT tablename FROM pg_tables
               WHERE schemaname = 'public' AND tablename NOT LIKE '\\_\\_drizzle%'
      LOOP EXECUTE 'TRUNCATE TABLE ' || quote_ident(t) || ' RESTART IDENTITY CASCADE'; END LOOP;
    END $$;
  `);
}

beforeAll(async () => {
  client = new PGlite();
  db = drizzle({ client, schema });
  await migrate(db, { migrationsFolder: MIGRATIONS });
  wiring.db = db;
}, 60_000);

afterAll(async () => {
  await client.close();
});

describe('refusing to clear the wrong database', () => {
  it('refuses production by name, whatever case the platform spells it in', () => {
    // The whole job of this command is to destroy data. The environment guard
    // catches the ordinary accident: a shell that still has production
    // credentials exported from an hour ago.
    for (const name of ['production', 'PRODUCTION', 'Prod', 'prod']) {
      expect(() => assertClearIsAllowed({ environmentName: name, confirmed: true })).toThrow(RefusedError);
    }
  });

  it('refuses without an explicit confirmation, even on a harmless environment', () => {
    // The second guard catches the other accident: a script that runs this
    // without anybody having decided to.
    expect(() => assertClearIsAllowed({ environmentName: 'staging', confirmed: false })).toThrow(RefusedError);
    expect(() => assertClearIsAllowed({ environmentName: undefined, confirmed: false })).toThrow(RefusedError);
  });

  it('allows a confirmed run against staging or a nameless local database', () => {
    expect(() => assertClearIsAllowed({ environmentName: 'staging', confirmed: true })).not.toThrow();
    expect(() => assertClearIsAllowed({ environmentName: undefined, confirmed: true })).not.toThrow();
  });

  it('names the two environments it protects, so adding one is a deliberate edit', () => {
    expect(PROTECTED_ENVIRONMENTS).toStrictEqual(['production', 'prod']);
  });

  it('says which guard refused, because the two need different answers', () => {
    // "Set GHALLA_ALLOW_DESTRUCTIVE=1" is actionable; on production it would be
    // the wrong advice, and the message must not offer it.
    expect(() => assertClearIsAllowed({ environmentName: 'prod', confirmed: true })).toThrow(
      /production data is restored from a backup/,
    );
    expect(() => assertClearIsAllowed({ environmentName: 'staging', confirmed: false })).toThrow(
      /GHALLA_ALLOW_DESTRUCTIVE=1/,
    );
  });
});

describe('emptying a database', () => {
  beforeEach(async () => {
    await emptyEverything();
    await seedDemoStore(db);
  });

  it('lists every table the migration created and none of drizzle’s bookkeeping', async () => {
    const tables = await listTables(db);
    expect(tables).toContain('orders');
    expect(tables).toContain('order_profit');
    expect(tables).toContain('cost_history');
    expect(tables.some((t) => t.startsWith('__drizzle'))).toBe(false);
    // Truncating drizzle's migration ledger would make the next `migrate` re-run
    // every migration against a database that already has the tables.
    expect(tables).toStrictEqual([...tables].sort());
  });

  it('reads the row shape the production driver returns, not only PGlite’s', async () => {
    // `node-postgres` answers with a Result object carrying `.rows`; drizzle
    // over PGlite answers with a bare array. Staging runs the first one, so a
    // command that only understands the second clears nothing and says so with
    // a cheerful "Cleared 0 tables".
    const asPgWould = {
      execute: (): Promise<unknown> => Promise.resolve({ rows: [{ tablename: 'orders' }] }),
    };
    expect(await listTables(asPgWould as never)).toStrictEqual(['orders']);
  });

  it('empties every table in one statement, foreign keys and all', async () => {
    const cleared = await clearAll(db);
    expect(cleared).toStrictEqual(await listTables(db));

    // `orders` references `stores`, and `order_items` references `orders`. A
    // delete-per-table would have to name them in the right order by hand and
    // would rot the first time a table is added.
    const storesLeft = await db.select().from(schema.stores);
    const ordersLeft = await db.select().from(schema.orders);
    const itemsLeft = await db.select().from(schema.orderItems);
    expect([storesLeft, ordersLeft, itemsLeft]).toStrictEqual([[], [], []]);
  });

  it('reports nothing to do against a database with no tables at all', async () => {
    // The clear step runs before migrations on a brand-new environment, where
    // TRUNCATE with an empty table list is a syntax error rather than a no-op.
    const bare = new PGlite();
    try {
      const bareDb = drizzle({ client: bare, schema });
      expect(await clearAll(bareDb)).toStrictEqual([]);
    } finally {
      await bare.close();
    }
  });
});

describe('the demo store the release verifies against', () => {
  beforeEach(async () => {
    await emptyEverything();
    await seedDemoStore(db);
  });

  it('inserts three orders for one store, every row surviving the schema’s constraints', async () => {
    const orders = await db.select().from(schema.orders).where(eq(schema.orders.storeId, SEED_STORE_ID));
    expect(orders).toHaveLength(SEED_EXPECTATIONS.orderCount);
    expect(orders.map((o) => o.id).sort()).toStrictEqual([
      SEED_EXPECTATIONS.prepaid.orderId,
      SEED_EXPECTATIONS.refusedCod.orderId,
      SEED_EXPECTATIONS.uncosted.orderId,
    ]);
  });

  it('leaves the second product with no cost row, which is every install’s day one', async () => {
    // SEED_EXPECTATIONS claims order 1003 reports `incomplete`. That is only
    // true while P2 has no cost: add one and the seed quietly stops exercising
    // the missing-cost path the activation loop is built on.
    const costs = await db.select().from(schema.costHistory).where(eq(schema.costHistory.storeId, SEED_STORE_ID));
    expect(costs.map((c) => c.platformProductId)).toStrictEqual(['P1']);

    const uncostedLine = await db
      .select()
      .from(schema.orderItems)
      .where(eq(schema.orderItems.orderId, SEED_EXPECTATIONS.uncosted.orderId));
    expect(uncostedLine[0]?.platformProductId).toBe('P2');
    expect(uncostedLine[0]?.costAtTimeMinor).toBeNull();
    expect(uncostedLine[0]?.costSource).toBe('none');
  });

  it('gives the refused parcel two shipping legs and never captures its cash', async () => {
    // A refused COD order is the dominant Saudi loss shape: freight out, freight
    // back, and no revenue at all. If either leg goes missing the seeded margin
    // stops being the number the smoke test thinks it is checking.
    const legs = await db
      .select()
      .from(schema.shipments)
      .where(eq(schema.shipments.orderId, SEED_EXPECTATIONS.refusedCod.orderId));
    expect(legs.map((s) => s.direction).sort()).toStrictEqual(['outbound', 'return']);
    expect(legs.every((s) => s.status === 'returned_to_origin')).toBe(true);

    const payments = await db
      .select()
      .from(schema.orderPayments)
      .where(eq(schema.orderPayments.orderId, SEED_EXPECTATIONS.refusedCod.orderId));
    expect(payments.map((p) => p.state)).toStrictEqual(['pending']);
  });

  it('stores every seeded amount as an exact number of halalas', async () => {
    // The seed writes decimal strings into numeric(14,2). A digit dropped on the
    // way in would show up nowhere else: the smoke test would simply assert a
    // different, equally confident, wrong margin.
    const [line] = await db
      .select()
      .from(schema.orderItems)
      .where(eq(schema.orderItems.id, 'demo:1:1001#L1'));
    expect(numericToMinor(line?.lineTotalExVatMinor ?? '0')).toBe(60_000);
    expect(numericToMinorOrNull(line?.costAtTimeMinor ?? null)).toBe(24_000);

    const [rule] = await db
      .select()
      .from(schema.shippingFallbackRules)
      .where(eq(schema.shippingFallbackRules.feeRuleSetId, SEED_FEE_RULE_SET_ID));
    expect(numericToMinor(rule?.costMinor ?? '0')).toBe(2_200);
  });

  it('produces the exact contribution margins the release gate asserts', async () => {
    // SEED_EXPECTATIONS is what the staging smoke test compares against. If the
    // seeded rows and those numbers ever drift apart, the gate passes on a
    // number nobody computed — so the two are tied together here, by running
    // the engine over what the seed actually wrote.
    const prepaid = await computeSeededOrder(SEED_EXPECTATIONS.prepaid.orderId);
    expect(prepaid.status).toBe('computed');
    if (prepaid.status !== 'computed') return;
    expect(prepaid.totals.contributionMarginMinor).toBe(
      SEED_EXPECTATIONS.prepaid.contributionMarginMinor,
    );

    const refused = await computeSeededOrder(SEED_EXPECTATIONS.refusedCod.orderId);
    expect(refused.status).toBe('computed');
    if (refused.status !== 'computed') return;
    expect(refused.totals.contributionMarginMinor).toBe(
      SEED_EXPECTATIONS.refusedCod.contributionMarginMinor,
    );
    // The loss is two shipping legs and nothing else: no revenue was recognised
    // and the goods came back on the shelf.
    expect(refused.totals.revenueExVatMinor).toBe(0);
  });

  it('leaves the uncosted order rankable only as a bound, never as a margin', async () => {
    const uncosted = await computeSeededOrder(SEED_EXPECTATIONS.uncosted.orderId);
    expect(uncosted.status).toBe('computed');
    if (uncosted.status !== 'computed') return;
    expect(uncosted.confidence.level).toBe(SEED_EXPECTATIONS.uncosted.confidenceLevel);
    // Zero recorded cost would otherwise read as a 100% margin — the single
    // most misleading number the product could show on a merchant's first day.
    expect(uncosted.diagnostics.map((d) => d.code)).toContain('COST_MISSING');
  });
});

describe('running the scripts as programs', () => {
  let consoleLog: MockInstance<typeof console.log>;
  let consoleError: MockInstance<typeof console.error>;
  let exit: MockInstance<typeof process.exit>;

  beforeEach(async () => {
    await emptyEverything();
    wiring.poolsEnded = 0;
    consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    vi.stubEnv('DATABASE_URL', 'postgres://user:pass@db:5432/ghalla');
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('RAILWAY_ENVIRONMENT_NAME', undefined);
    vi.stubEnv('GHALLA_ALLOW_DESTRUCTIVE', undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  /**
   * Runs a module the way `node dist/…` would: `import.meta.url` matching
   * argv[1] is what makes these files a program rather than a library, and it is
   * the branch that decides whether importing the seed helper in a test also
   * seeds the database.
   */
  async function runAsProgram(script: string, specifier: string): Promise<void> {
    const previous = [...process.argv];
    process.argv[1] = script;
    vi.resetModules();
    try {
      await import(specifier);
      await vi.waitFor(() => {
        expect(consoleLog.mock.calls.length + consoleError.mock.calls.length).toBeGreaterThan(0);
      });
    } finally {
      process.argv = previous;
    }
  }

  it('does not run when it is merely imported', async () => {
    // Every test above imports both modules. If the entry guard were wrong they
    // would truncate and re-seed the database on import, which is exactly the
    // accident the guard exists to prevent in a deployed process too.
    vi.resetModules();
    await import('../src/db/clear.js');
    expect(consoleLog).not.toHaveBeenCalled();
    expect(wiring.poolsEnded).toBe(0);
  });

  it('stops the clear command before it opens a pool when DATABASE_URL is unset', async () => {
    vi.stubEnv('DATABASE_URL', undefined);
    vi.stubEnv('GHALLA_ALLOW_DESTRUCTIVE', '1');
    await runAsProgram(CLEAR_SCRIPT, '../src/db/clear.js');

    expect(exit).toHaveBeenCalledWith(1);
    expect(consoleError).toHaveBeenCalledWith('DATABASE_URL is not defined');
    expect(wiring.poolsEnded).toBe(0);
  });

  it('refuses to clear a production database and exits non-zero without touching a row', async () => {
    await seedDemoStore(db);
    vi.stubEnv('RAILWAY_ENVIRONMENT_NAME', 'production');
    vi.stubEnv('GHALLA_ALLOW_DESTRUCTIVE', '1');
    await runAsProgram(CLEAR_SCRIPT, '../src/db/clear.js');

    // A non-zero exit is what stops a release pipeline. Exiting 0 here would let
    // the next step seed demo orders on top of a merchant's real ones.
    expect(exit).toHaveBeenCalledWith(1);
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('Refusing to clear the production'));
    expect(await db.select().from(schema.orders)).toHaveLength(SEED_EXPECTATIONS.orderCount);
  });

  it('refuses on an unconfirmed run even when the environment name says staging', async () => {
    vi.stubEnv('RAILWAY_ENVIRONMENT_NAME', 'staging');
    await runAsProgram(CLEAR_SCRIPT, '../src/db/clear.js');

    expect(exit).toHaveBeenCalledWith(1);
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('GHALLA_ALLOW_DESTRUCTIVE=1'));
  });

  it('clears, reports what it cleared, and closes its pool', async () => {
    await seedDemoStore(db);
    vi.stubEnv('GHALLA_ALLOW_DESTRUCTIVE', '1');
    await runAsProgram(CLEAR_SCRIPT, '../src/db/clear.js');

    expect(exit).not.toHaveBeenCalled();
    expect(consoleLog).toHaveBeenCalledWith(expect.stringContaining('Cleared'));
    expect(await db.select().from(schema.orders)).toStrictEqual([]);
    // Postgres caps connections, and a script that leaks its pool on every
    // release run reaches that cap after a surprisingly small number of them.
    expect(wiring.poolsEnded).toBe(1);
  });

  it('seeds the demo store and says how many orders it wrote', async () => {
    await runAsProgram(SEED_SCRIPT, '../src/db/seeds/demo-store.js');

    expect(exit).not.toHaveBeenCalled();
    expect(consoleLog).toHaveBeenCalledWith(
      `Seeded store ${SEED_STORE_ID} with ${String(SEED_EXPECTATIONS.orderCount)} orders`,
    );
    expect(await db.select().from(schema.orders)).toHaveLength(SEED_EXPECTATIONS.orderCount);
    expect(wiring.poolsEnded).toBe(1);
  });

  it('stops the seed before it opens a pool when DATABASE_URL is unset', async () => {
    vi.stubEnv('DATABASE_URL', undefined);
    await runAsProgram(SEED_SCRIPT, '../src/db/seeds/demo-store.js');

    expect(exit).toHaveBeenCalledWith(1);
    expect(consoleError).toHaveBeenCalledWith('DATABASE_URL is not defined');
    expect(await db.select().from(schema.orders)).toStrictEqual([]);
  });
});

describe('the clear → seed cycle a release runs', () => {
  beforeEach(async () => {
    await emptyEverything();
  });

  it('re-seeds a cleared database to exactly the same rows', async () => {
    // The reason the clear step uses RESTART IDENTITY: a seeded environment has
    // to be reproducible, not merely empty, or two release runs assert against
    // two different databases and only one of them is the one that was tested.
    // `createdAt` and `updatedAt` default to now() in the database and are audit
    // columns rather than seeded data, so they are the one thing allowed to
    // differ between two runs. Everything a margin is computed from is not.
    const businessColumns = async (): Promise<unknown[]> =>
      (await db.select().from(schema.orders).orderBy(schema.orders.id)).map(
        ({ createdAt: _createdAt, updatedAt: _updatedAt, ...rest }) => rest,
      );

    await seedDemoStore(db);
    const first = await businessColumns();
    await clearAll(db);
    await seedDemoStore(db);
    expect(await businessColumns()).toStrictEqual(first);
  });
});

/**
 * Reads one seeded order back out and runs the engine over it.
 *
 * Everything here comes from the tables the seed wrote, so the margins asserted
 * above are the seed's numbers rather than a second copy of them typed into a
 * test.
 */
async function computeSeededOrder(id: string): Promise<ReturnType<typeof computeOrderProfit>> {
  const orderId = idFromString<'order'>(id) as OrderId;
  const [store] = await db.select().from(schema.stores).where(eq(schema.stores.id, SEED_STORE_ID));
  const [row] = await db.select().from(schema.orders).where(eq(schema.orders.id, id));
  if (store === undefined || row === undefined) throw new Error(`The seed did not write ${id}.`);

  const itemRows = await db.select().from(schema.orderItems).where(eq(schema.orderItems.orderId, id));
  const paymentRows = await db
    .select()
    .from(schema.orderPayments)
    .where(eq(schema.orderPayments.orderId, id))
    .orderBy(schema.orderPayments.legIndex);
  const shipmentRows = await db.select().from(schema.shipments).where(eq(schema.shipments.orderId, id));
  const costRows = await db.select().from(schema.costHistory).where(eq(schema.costHistory.storeId, SEED_STORE_ID));
  const gatewayRows = await db
    .select()
    .from(schema.gatewayFeeRules)
    .where(eq(schema.gatewayFeeRules.feeRuleSetId, SEED_FEE_RULE_SET_ID));
  const codRows = await db
    .select()
    .from(schema.codFeeRules)
    .where(eq(schema.codFeeRules.feeRuleSetId, SEED_FEE_RULE_SET_ID));
  const shippingRows = await db
    .select()
    .from(schema.shippingFallbackRules)
    .where(eq(schema.shippingFallbackRules.feeRuleSetId, SEED_FEE_RULE_SET_ID));

  interface FormulaRow {
    readonly percentBps: number;
    readonly fixedMinor: string;
    readonly minFeeMinor: string | null;
    readonly maxFeeMinor: string | null;
    readonly feeVatBps: number;
    readonly ratesIncludeVat: boolean;
    readonly source: string;
  }

  const formula = (r: FormulaRow): Omit<GatewayFeeRule, 'instrument' | 'scheme' | 'provider'> => ({
    percentBps: toBps(r.percentBps),
    fixedMinor: numericToMinor(r.fixedMinor),
    minFeeMinor: numericToMinorOrNull(r.minFeeMinor),
    maxFeeMinor: numericToMinorOrNull(r.maxFeeMinor),
    feeVatBps: toBps(r.feeVatBps),
    ratesIncludeVat: r.ratesIncludeVat,
    source: r.source as GatewayFeeRule['source'],
  });

  const payments: PaymentBreakdown[] = paymentRows.map((p) => ({
    instrument: p.instrument as PaymentInstrument,
    scheme: p.scheme as CardScheme | null,
    wallet: null,
    provider: null,
    rawMethodLabel: p.rawMethodLabel,
    state: p.state as PaymentBreakdown['state'],
    amountGrossMinor: numericToMinor(p.amountGrossMinor),
    transactionRef: p.transactionRef,
  }));

  const order: CanonicalOrder = {
    id: orderId,
    storeId: SEED_STORE_ID as StoreId,
    platformOrderId: row.platformOrderId,
    placedAt: toInstant(row.placedAt.toISOString()),
    platformUpdatedAt: null,
    lifecycle: row.lifecycle as CanonicalOrder['lifecycle'],
    paymentState: row.paymentState as PaymentState,
    fulfillmentState: row.fulfillmentState as CanonicalOrder['fulfillmentState'],
    platformStatusId: null,
    rawStatusLabel: row.rawStatusLabel,
    isTest: row.isTest,
    fulfillmentMethod: row.fulfillmentMethod as CanonicalOrder['fulfillmentMethod'],
    destination:
      row.destinationCountryCode === null
        ? null
        : {
            countryCode: row.destinationCountryCode,
            region: row.destinationRegion,
            city: row.destinationCity,
          },
    currency: 'SAR',
    vatRateBps: toBps(row.vatRateBps),
    subtotalExVatMinor: numericToMinor(row.subtotalExVatMinor),
    vatAmountMinor: numericToMinor(row.vatAmountMinor),
    shippingChargedExVatMinor: numericToMinor(row.shippingChargedExVatMinor),
    codFeeChargedExVatMinor: numericToMinor(row.codFeeChargedExVatMinor),
    totalIncVatMinor: numericToMinor(row.totalIncVatMinor),
    discounts: [],
    payments,
    customerRef: null,
    attribution: null,
  };

  const items: CanonicalOrderItem[] = itemRows.map((i) => ({
    id: idFromString<'orderItem'>(i.id),
    orderId,
    platformLineId: i.platformLineId,
    platformProductId: i.platformProductId,
    platformVariantId: i.platformVariantId,
    sku: i.sku,
    productName: i.productName,
    quantity: i.quantity,
    unitPriceExVatMinor: numericToMinor(i.unitPriceExVatMinor),
    grossLineExVatMinor: numericToMinor(i.grossLineExVatMinor),
    lineDiscountExVatMinor: numericToMinor(i.lineDiscountExVatMinor),
    lineTotalExVatMinor: numericToMinor(i.lineTotalExVatMinor),
  }));

  const shipments: CanonicalShipment[] = shipmentRows.map((s) => ({
    id: idFromString<'shipment'>(s.id),
    orderId,
    platformShipmentId: s.platformShipmentId,
    direction: s.direction as CanonicalShipment['direction'],
    status: s.status as CanonicalShipment['status'],
    carrier: s.carrier,
    rawCarrierLabel: s.rawCarrierLabel,
    carrierCostMinor: numericToMinorOrNull(s.carrierCostMinor),
    lines: [],
    shippedAt: null,
    deliveredAt: null,
    platformUpdatedAt: null,
  }));

  const input: OrderProfitInput = {
    store: {
      storeId: SEED_STORE_ID as StoreId,
      currency: 'SAR',
      timezone: store.timezone,
      vatRegistered: store.vatRegistered,
    },
    order,
    items,
    shipments,
    reversals: [],
    costs: costRows.map((c) => ({
      platformProductId: c.platformProductId,
      platformVariantId: c.platformVariantId,
      sku: c.sku,
      unitCostMinor: numericToMinor(c.unitCostMinor),
      source: c.source as CostSource,
      costHistoryId: idFromString<'costHistory'>(c.id),
    })),
    feeRuleSet: {
      id: idFromString<'feeRuleSet'>(SEED_FEE_RULE_SET_ID) as FeeRuleSetId,
      currency: 'SAR',
      gateway: gatewayRows.map((r) => ({
        instrument: r.instrument as PaymentInstrument | null,
        scheme: r.scheme as CardScheme | null,
        provider: r.provider,
        ...formula(r),
      })),
      cod: codRows.map(
        (r): CodFeeRule => ({
          carrier: r.carrier,
          ...formula(r),
        }),
      ),
      shippingFallback: shippingRows.map(
        (r): ShippingFallbackRule => ({
          countryCode: r.countryCode,
          region: r.region,
          carrier: r.carrier,
          direction: r.direction as ShippingFallbackRule['direction'],
          costMinor: numericToMinor(r.costMinor),
        }),
      ),
    },
  };

  // Every money field arrived as a decimal string from the column; nothing here
  // may reach the engine as a float.
  expect(items.every((i) => Number.isSafeInteger(i.lineTotalExVatMinor))).toBe(true);
  expect(toMinor(order.totalIncVatMinor)).toBe(order.totalIncVatMinor);

  return computeOrderProfit(input);
}
