import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import * as schema from '@ghalla/persistence/schema';
import type { ReadOnlyDatabase } from '../../src/lib/platforms/read-only';

/**
 * A REAL integration database for the query tests.
 *
 * PGlite is Postgres compiled to WebAssembly, migrated with the integration's
 * own migration set — not a copy of it, the same files the integration service
 * deploys. That matters more here than in a typical query test: these queries
 * are the only place the portal's numbers come from, and a mock would happily
 * agree with a `filter (where …)` clause that Postgres rejects, a half-open
 * range written closed, or a LEFT JOIN silently turned into an inner one by a
 * condition in the wrong clause.
 *
 * Reached by relative path on purpose. The portal's boundary rules forbid
 * importing the integration's write repositories, and a test that needs the
 * MIGRATIONS is asking for something the package ships but does not export.
 */
const MIGRATIONS = path.resolve(import.meta.dirname, '../../../../packages/persistence/drizzle');

/** Fixed, so "24 hours ago" is a date and not a race. */
export const NOW = new Date('2026-09-05T12:00:00.000Z');

export function at(offsetMs: number): string {
  return new Date(NOW.getTime() + offsetMs).toISOString();
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export interface IntegrationDb {
  readonly client: PGlite;
  readonly db: ReadOnlyDatabase;
  close(): Promise<void>;
}

export async function createIntegrationDb(): Promise<IntegrationDb> {
  const client = new PGlite();
  const db = drizzle({ client, schema });
  await migrate(db, { migrationsFolder: MIGRATIONS });
  return {
    client,
    db,
    close: async () => {
      await client.close();
    },
  };
}

const store = (id: string, installedOffsetMs: number, uninstalled: string | null): string => `
  INSERT INTO stores (id, platform, platform_store_id, currency, timezone, vat_rate_bps, vat_registered,
    installed_at, uninstalled_at)
  VALUES ('${id}', 'demo', '${id.split(':')[1] ?? id}', 'SAR', 'Asia/Riyadh', 1500, true,
    '${at(installedOffsetMs)}', ${uninstalled === null ? 'NULL' : `'${uninstalled}'`})`;

const subscription = (
  id: string,
  planCode: string,
  status: string,
  periodStartOffsetMs: number,
  periodEndOffsetMs: number,
  extra = '',
): string => `
  INSERT INTO store_subscription (store_id, plan_code, status, current_period_start, current_period_end${
    extra === '' ? '' : ', pending_plan_code, pending_plan_effective_at'
  })
  VALUES ('${id}', '${planCode}', '${status}', '${at(periodStartOffsetMs)}', '${at(periodEndOffsetMs)}'${extra})`;

const order = (
  storeId: string,
  n: number,
  placedOffsetMs: number,
  source: string,
  isTest = false,
): string => `
  INSERT INTO orders (id, store_id, platform_order_id, placed_at, lifecycle, payment_state, fulfillment_state,
    raw_status_label, fulfillment_method, currency, vat_rate_bps, ingestion_source, is_test,
    subtotal_ex_vat_minor, vat_amount_minor, shipping_charged_ex_vat_minor, cod_fee_charged_ex_vat_minor,
    total_inc_vat_minor)
  VALUES ('${storeId}:${String(n)}', '${storeId}', '${String(n)}', '${at(placedOffsetMs)}', 'open', 'paid',
    'delivered', 'delivered', 'carrier', 'SAR', 1500, '${source}', ${String(isTest)},
    '100.00', '15.00', '0.00', '0.00', '115.00')`;

const rollup = (storeId: string, date: string, revenue: string, covered: string, orders: number, dirty = false): string => `
  INSERT INTO daily_store_rollup (store_id, business_date, orders_count, revenue_ex_vat_minor,
    cost_covered_revenue_ex_vat_minor, dirty)
  VALUES ('${storeId}', '${date}', ${String(orders)}, '${revenue}', '${covered}', ${String(dirty)})`;

const webhook = (storeId: string, n: number, receivedOffsetMs: number, status: string, lockedOffsetMs: number | null = null): string => `
  INSERT INTO webhook_events (id, store_id, platform_event_id, event_type, raw_event_type, received_at, status,
    attempts, locked_at)
  VALUES ('${storeId}:e${String(n)}', '${storeId}', 'e${String(n)}', 'order.created', 'order.created',
    '${at(receivedOffsetMs)}', '${status}', 1, ${lockedOffsetMs === null ? 'NULL' : `'${at(lockedOffsetMs)}'`})`;

const backfill = (storeId: string, status: string, startedOffsetMs: number): string => `
  INSERT INTO backfill_cursors (store_id, resource, status, items_fetched, created_at)
  VALUES ('${storeId}', 'orders', '${status}', 10, '${at(startedOffsetMs)}')`;

/**
 * `scheme` is set for a card and only for a card — the integration schema has a
 * CHECK saying exactly that, and it rejected the first version of this fixture.
 * Which is the argument for running these tests against real Postgres.
 */
const payment = (
  storeId: string,
  orderN: number,
  instrument: string,
  label: string,
  scheme: string | null = null,
  leg = 0,
): string => `
  INSERT INTO order_payments (id, order_id, leg_index, instrument, scheme, raw_method_label, state,
    amount_gross_minor)
  VALUES ('${storeId}:${String(orderN)}:${String(leg)}', '${storeId}:${String(orderN)}', ${String(leg)},
    '${instrument}', ${scheme === null ? 'NULL' : `'${scheme}'`}, '${label}', 'captured', '115.00')`;

/**
 * Five stores, each one a case the derivations have to get right.
 *
 *   demo:1  healthy — recent webhooks, complete backfill, good coverage
 *   demo:2  silent — installed long ago, nothing heard for three days
 *   demo:3  past_due, low coverage, a backfill that started a week ago
 *   demo:4  trialing and installed TWO HOURS AGO — must not read as silent
 *   demo:5  uninstalled — must not alert at all
 *   demo:6  installed with NO subscription row yet, which is what a store looks
 *           like between its install webhook and its first billing webhook
 *   demo:7  on a plan code this build has never heard of, which is what a
 *           rollback to an older image looks like from the portal's side
 */
export async function seed(client: PGlite): Promise<void> {
  const statements = [
    store('demo:1', -60 * DAY, null),
    store('demo:2', -60 * DAY, null),
    store('demo:3', -60 * DAY, null),
    store('demo:4', -2 * HOUR, null),
    store('demo:5', -90 * DAY, at(-3 * DAY)),
    store('demo:6', -30 * DAY, null),
    store('demo:7', -30 * DAY, null),

    subscription('demo:1', 'growth', 'active', -10 * DAY, 20 * DAY),
    subscription('demo:2', 'starter', 'active', -10 * DAY, 20 * DAY),
    subscription('demo:3', 'scale', 'past_due', -10 * DAY, 20 * DAY),
    subscription('demo:4', 'growth', 'trialing', -2 * HOUR, 14 * DAY),
    subscription('demo:5', 'starter', 'canceled', -40 * DAY, -10 * DAY),
    subscription('demo:7', 'growth_v99', 'active', -10 * DAY, 20 * DAY),

    // demo:1 — three live orders inside the period, one backfilled, one outside.
    order('demo:1', 1, -5 * DAY, 'live'),
    order('demo:1', 2, -4 * DAY, 'live'),
    order('demo:1', 3, -1 * HOUR, 'live'),
    order('demo:1', 4, -5 * DAY, 'backfill'),
    order('demo:1', 5, -30 * DAY, 'live'),
    // Exactly on each boundary of demo:1's half-open window.
    order('demo:1', 6, -10 * DAY, 'live'),
    order('demo:1', 7, 20 * DAY, 'live'),

    order('demo:2', 1, -20 * DAY, 'live'),
    order('demo:3', 1, -2 * DAY, 'live'),

    // A TEST order, placed outside demo:1's billing period so it cannot move the
    // metering count, carrying an unmapped rail. It must not appear in the
    // queue: a test order is not evidence a rail deserves a fee rule.
    order('demo:1', 8, -30 * DAY, 'live', true),

    payment('demo:1', 1, 'card', 'mada', 'mada'),
    payment('demo:1', 2, 'unknown', 'tabby_installments'),
    payment('demo:1', 3, 'unknown', 'tabby_installments'),
    payment('demo:1', 8, 'unknown', 'test_only_rail'),
    // ONE order settled in TWO captures on the same unmapped rail. It is one
    // order, and `count(*)` over legs would call it two.
    payment('demo:3', 1, 'other', 'bank_cheque'),
    payment('demo:3', 1, 'other', 'bank_cheque', null, 1),

    rollup('demo:1', '2026-09-05', '1000.00', '900.00', 3),
    rollup('demo:1', '2026-09-01', '500.00', '400.00', 2),
    rollup('demo:1', '2026-07-01', '900.00', '0.00', 4),
    rollup('demo:2', '2026-09-04', '200.00', '150.00', 1, true),
    rollup('demo:3', '2026-09-03', '1000.00', '100.00', 5),

    webhook('demo:1', 1, -1 * HOUR, 'processed'),
    webhook('demo:1', 2, -2 * HOUR, 'processed'),
    webhook('demo:1', 3, -3 * HOUR, 'pending'),
    webhook('demo:2', 1, -3 * DAY, 'processed'),
    webhook('demo:3', 1, -2 * HOUR, 'failed'),
    webhook('demo:3', 2, -3 * HOUR, 'failed'),
    webhook('demo:3', 3, -4 * HOUR, 'failed'),
    webhook('demo:3', 4, -5 * HOUR, 'failed'),
    webhook('demo:3', 5, -6 * HOUR, 'failed'),
    webhook('demo:3', 6, -7 * HOUR, 'failed'),
    // Held by a worker for an hour — far beyond the stall threshold.
    webhook('demo:1', 8, -2 * HOUR, 'processing', -1 * HOUR),

    backfill('demo:1', 'complete', -50 * DAY),
    backfill('demo:2', 'complete', -50 * DAY),
    backfill('demo:3', 'running', -7 * DAY),
    backfill('demo:4', 'running', -1 * HOUR),
  ];

  for (const statement of statements) await client.exec(statement);
}
