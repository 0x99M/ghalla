import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import path from 'node:path';
import { idFromString, toInstant } from '@ghalla/contracts';
import type { Instant, StoreId } from '@ghalla/contracts';
import type { Subscription } from '@ghalla/billing';
import { usageWindow } from '@ghalla/billing';
import * as schema from '../src/db/schema.js';
import { SubscriptionRepository } from '../src/repositories/subscription.repository.js';

let client: PGlite;
let db: ReturnType<typeof drizzle<typeof schema>>;
let repo: SubscriptionRepository;

const STORE_ID = idFromString<'store'>('demo:1') as StoreId;
const OTHER_STORE = idFromString<'store'>('demo:2') as StoreId;
const at = (iso: string): Instant => toInstant(iso);
const NOW = at('2026-03-15T00:00:00.000Z');

const subscription = (over: Partial<Subscription> = {}): Subscription => ({
  storeId: STORE_ID,
  planCode: 'starter',
  platformPlanId: 'plat_1',
  status: 'active',
  trialEndsAt: null,
  currentPeriodStart: at('2026-03-01T00:00:00.000Z'),
  currentPeriodEnd: at('2026-04-01T00:00:00.000Z'),
  lastEventAt: null,
  lastReconciledAt: null,
  pendingPlanCode: null,
  pendingPlanEffectiveAt: null,
  ...over,
});

const store = (id: StoreId, platformStoreId: string): typeof schema.stores.$inferInsert => ({
  id,
  platform: 'demo',
  platformStoreId,
  currency: 'SAR',
  timezone: 'Asia/Riyadh',
  vatRateBps: 1500,
  vatRegistered: true,
  installedAt: new Date('2026-01-01T00:00:00.000Z'),
});

let orderSeq = 0;
const order = (
  placedAt: string,
  ingestionSource: 'live' | 'backfill',
  over: Partial<typeof schema.orders.$inferInsert> = {},
): typeof schema.orders.$inferInsert => {
  orderSeq += 1;
  const id = `demo:1:o${String(orderSeq)}`;
  return {
    id,
    storeId: STORE_ID,
    platformOrderId: String(orderSeq),
    placedAt: new Date(placedAt),
    lifecycle: 'open',
    paymentState: 'paid',
    fulfillmentState: 'delivered',
    rawStatusLabel: 'delivered',
    fulfillmentMethod: 'carrier',
    currency: 'SAR',
    vatRateBps: 1500,
    ingestionSource,
    subtotalExVatMinor: '100.00',
    vatAmountMinor: '15.00',
    shippingChargedExVatMinor: '0.00',
    codFeeChargedExVatMinor: '0.00',
    totalIncVatMinor: '115.00',
    ...over,
  };
};

beforeAll(async () => {
  client = new PGlite();
  db = drizzle({ client, schema });
  await migrate(db, { migrationsFolder: path.resolve(import.meta.dirname, '..', 'drizzle') });
  await db.insert(schema.stores).values([store(STORE_ID, '1'), store(OTHER_STORE, '2')]);
  repo = new SubscriptionRepository(db);
}, 60_000);

afterAll(async () => {
  await client.close();
});

beforeEach(async () => {
  await db.delete(schema.orders);
  await db.delete(schema.storeSubscription);
});

describe('the subscription row', () => {
  it('round-trips every field', async () => {
    const written = subscription({
      status: 'trialing',
      trialEndsAt: at('2026-03-20T00:00:00.000Z'),
      lastEventAt: at('2026-03-10T00:00:00.000Z'),
      lastReconciledAt: at('2026-03-14T03:00:00.000Z'),
    });
    await repo.save(written, NOW);
    expect(await repo.find(STORE_ID)).toStrictEqual(written);
  });

  it('creates on first write and updates on the next', async () => {
    // The first billing event a store gets and the fiftieth arrive through the
    // same path; a read-then-branch would race two deliveries of the first.
    await repo.save(subscription({ status: 'trialing' }), NOW);
    await repo.save(subscription({ status: 'active', planCode: 'growth' }), NOW);
    const found = await repo.find(STORE_ID);
    expect(found?.status).toBe('active');
    expect(found?.planCode).toBe('growth');
  });

  it('round-trips a downgrade that has not taken effect yet', async () => {
    // The two pending columns are what keep a merchant on the tier they have
    // already paid for until the cycle ends. A round trip that dropped them
    // would apply the downgrade the moment the row was next read.
    const scheduled = subscription({
      planCode: 'growth',
      pendingPlanCode: 'starter',
      pendingPlanEffectiveAt: at('2026-04-01T00:00:00.000Z'),
    });
    await repo.save(scheduled, NOW);
    expect(await repo.find(STORE_ID)).toStrictEqual(scheduled);
  });

  it('refuses half a pending downgrade', async () => {
    // A code with no date never takes effect; a date with no code is a rollover
    // that changes nothing. Either half alone is a downgrade the merchant asked
    // for that silently never happens.
    await repo.save(subscription(), NOW);
    await expect(
      client.exec(
        `UPDATE store_subscription SET pending_plan_code = 'starter' WHERE store_id = 'demo:1'`,
      ),
    ).rejects.toThrow(/store_subscription_pending_plan_complete/);
  });

  it('returns null for a store with no subscription yet', async () => {
    // An install whose billing webhook has not landed. The caller decides what
    // that means — guessing here would put an entitlement decision in a
    // repository.
    expect(await repo.find(STORE_ID)).toBeNull();
  });

  it('accepts a plan code the database has never heard of', async () => {
    // No CHECK and no foreign key on plan_code, on purpose: plans live in code
    // so that adding a tier is a reviewable diff rather than a migration.
    await repo.save(subscription({ planCode: 'growth_v7_experiment' }), NOW);
    expect((await repo.find(STORE_ID))?.planCode).toBe('growth_v7_experiment');
  });

  it('refuses a status outside the lifecycle', async () => {
    // Raw SQL, matching schema.test.ts: the driver names the constraint it
    // rejected, where drizzle wraps it in a generic "Failed query".
    await repo.save(subscription(), NOW);
    await expect(
      client.exec(`UPDATE store_subscription SET status = 'suspended' WHERE store_id = 'demo:1'`),
    ).rejects.toThrow(/store_subscription_status_valid/);
  });

  it('refuses a period that ends before it starts', async () => {
    // A negative window puts every order outside it: the merchant reads zero
    // orders and an untouched cap while ingestion runs perfectly.
    await repo.save(subscription(), NOW);
    await expect(
      client.exec(
        `UPDATE store_subscription SET current_period_end = '2026-02-01T00:00:00Z' WHERE store_id = 'demo:1'`,
      ),
    ).rejects.toThrow(/store_subscription_period_ordered/);
  });
});

describe('metering', () => {
  it('does not count a backfill toward the cap', async () => {
    // THE case this column exists for. A merchant installs, three years of
    // history arrives, and without this they blow a 300-order cap on their
    // first day — billed for work they did before they had heard of us.
    const backfill = Array.from({ length: 400 }, (_, i) =>
      order(`2026-03-${String((i % 28) + 1).padStart(2, '0')}T10:00:00.000Z`, 'backfill'),
    );
    await db.insert(schema.orders).values(backfill);
    await db.insert(schema.orders).values([order('2026-03-05T10:00:00.000Z', 'live')]);

    const window = usageWindow(subscription());
    expect(await repo.countLiveOrders(STORE_ID, window)).toBe(1);
  });

  it('counts refunded and cancelled orders — they were still ingested', async () => {
    // Metering is about work done, not revenue kept. An order that was
    // ingested, normalized and computed cost us the same whether or not the
    // customer sent it back, and excluding it would let a high-refund store
    // meter a fraction of its real volume.
    await db.insert(schema.orders).values([
      order('2026-03-05T10:00:00.000Z', 'live', { lifecycle: 'cancelled' }),
      order('2026-03-06T10:00:00.000Z', 'live', { paymentState: 'refunded' }),
      order('2026-03-07T10:00:00.000Z', 'live'),
    ]);
    expect(await repo.countLiveOrders(STORE_ID, usageWindow(subscription()))).toBe(3);
  });

  it('counts an order placed one second before the period ends', async () => {
    // The window is half-open, [start, end). This order is inside it.
    await db.insert(schema.orders).values([order('2026-03-31T23:59:59.000Z', 'live')]);
    expect(await repo.countLiveOrders(STORE_ID, usageWindow(subscription()))).toBe(1);
  });

  it('does not count an order placed exactly at the period end', async () => {
    // That one belongs to the NEXT period. A closed interval would count it
    // twice: once against the cap the merchant already paid for, and once
    // against the one they just renewed.
    await db.insert(schema.orders).values([order('2026-04-01T00:00:00.000Z', 'live')]);
    expect(await repo.countLiveOrders(STORE_ID, usageWindow(subscription()))).toBe(0);
  });

  it('counts an order placed exactly at the period start', async () => {
    await db.insert(schema.orders).values([order('2026-03-01T00:00:00.000Z', 'live')]);
    expect(await repo.countLiveOrders(STORE_ID, usageWindow(subscription()))).toBe(1);
  });

  it('does not count another store’s orders', async () => {
    await db.insert(schema.orders).values([
      { ...order('2026-03-05T10:00:00.000Z', 'live'), id: 'demo:2:o1', storeId: OTHER_STORE },
    ]);
    expect(await repo.countLiveOrders(STORE_ID, usageWindow(subscription()))).toBe(0);
  });

  it('defaults an order with no stated provenance to live', async () => {
    // The safe direction: a backfill that forgets to set the column
    // over-counts and gets noticed, where defaulting to `backfill` would
    // silently meter nothing at all.
    const values = order('2026-03-05T10:00:00.000Z', 'live');
    delete (values as { ingestionSource?: string }).ingestionSource;
    await db.insert(schema.orders).values([values]);
    expect(await repo.countLiveOrders(STORE_ID, usageWindow(subscription()))).toBe(1);
  });

  it('refuses a provenance that is neither live nor backfill', async () => {
    await db.insert(schema.orders).values([order('2026-03-05T10:00:00.000Z', 'live')]);
    await expect(
      client.exec(`UPDATE orders SET ingestion_source = 'guessed'`),
    ).rejects.toThrow(/orders_ingestion_source_valid/);
  });
});

describe('the reconciler’s work list', () => {
  it('puts never-reconciled stores at the head', async () => {
    // A store that has never been checked is the one most likely to be wrong.
    await repo.save(subscription({ lastReconciledAt: at('2026-03-14T00:00:00.000Z') }), NOW);
    await repo.save(subscription({ storeId: OTHER_STORE, lastReconciledAt: null }), NOW);

    const due = await repo.dueForReconciliation(10);
    expect(due.map((s) => s.storeId)).toStrictEqual([OTHER_STORE, STORE_ID]);
  });

  it('serves the stalest first, so a partial pass still makes progress', async () => {
    await repo.save(subscription({ lastReconciledAt: at('2026-03-14T00:00:00.000Z') }), NOW);
    await repo.save(
      subscription({ storeId: OTHER_STORE, lastReconciledAt: at('2026-03-01T00:00:00.000Z') }),
      NOW,
    );
    const due = await repo.dueForReconciliation(1);
    expect(due).toHaveLength(1);
    expect(due[0]?.storeId).toBe(OTHER_STORE);
  });

  it('sends a store back to the head of the queue on request', async () => {
    // A merchant asking for a refresh. Clearing last_reconciled_at reuses the
    // ordering the sweep already has rather than inventing a second "please
    // check me" flag that could disagree with it — and it means the request
    // survives a restart, because the row is the queue.
    await repo.save(subscription({ lastReconciledAt: at('2026-03-30T00:00:00.000Z') }), NOW);
    await repo.save(
      subscription({ storeId: OTHER_STORE, lastReconciledAt: at('2026-03-01T00:00:00.000Z') }),
      NOW,
    );
    await repo.markDueForReconciliation(STORE_ID);

    expect((await repo.find(STORE_ID))?.lastReconciledAt).toBeNull();
    const due = await repo.dueForReconciliation(10);
    expect(due[0]?.storeId).toBe(STORE_ID);
  });

  it('advances the sweep even when nothing changed', async () => {
    await repo.save(subscription(), NOW);
    await repo.markReconciled(STORE_ID, at('2026-03-31T03:00:00.000Z'));
    expect((await repo.find(STORE_ID))?.lastReconciledAt).toBe(at('2026-03-31T03:00:00.000Z'));
  });
});

describe('the observability surface', () => {
  it('reports every status including the ones at zero', async () => {
    await repo.save(subscription({ status: 'active' }), NOW);
    await repo.save(subscription({ storeId: OTHER_STORE, status: 'past_due' }), NOW);
    expect(await repo.countByStatus()).toStrictEqual({
      trialing: 0,
      active: 1,
      past_due: 1,
      canceled: 0,
      expired: 0,
    });
  });
});
