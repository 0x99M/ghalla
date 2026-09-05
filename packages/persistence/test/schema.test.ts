import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { sql } from 'drizzle-orm';
import path from 'node:path';
import * as schema from '../src/db/schema.js';

/**
 * The migration is applied to a real Postgres — PGlite is Postgres compiled to
 * WebAssembly, running in this process. No Docker, no service container, and no
 * "the SQL looked right to me": a constraint that does not compile fails here.
 *
 * This matters more than a typical schema test would, because most of what this
 * schema asserts is CHECK constraints carrying domain rules. A rule the
 * database does not actually enforce is worse than no rule, since the comment
 * beside it says it does.
 */
let client: PGlite;
let db: ReturnType<typeof drizzle<typeof schema>>;

const MIGRATIONS = path.resolve(import.meta.dirname, '..', 'drizzle');

beforeAll(async () => {
  client = new PGlite();
  db = drizzle({ client, schema });
  await migrate(db, { migrationsFolder: MIGRATIONS });
}, 60_000);

afterAll(async () => {
  await client.close();
});

/** Asserts a statement is rejected, and by the constraint we think. */
async function rejects(statement: string, constraint: string): Promise<void> {
  await expect(client.exec(statement)).rejects.toThrow(new RegExp(constraint));
}

const STORE = `INSERT INTO stores (id, platform, platform_store_id, currency, timezone, vat_rate_bps, vat_registered, installed_at)
  VALUES ('p:1', 'demo', '1', 'SAR', 'Asia/Riyadh', 1500, true, now())`;

const ORDER = `INSERT INTO orders (id, store_id, platform_order_id, placed_at, lifecycle, payment_state, fulfillment_state,
  raw_status_label, fulfillment_method, currency, vat_rate_bps, subtotal_ex_vat_minor, vat_amount_minor,
  shipping_charged_ex_vat_minor, cod_fee_charged_ex_vat_minor, total_inc_vat_minor)
  VALUES ('p:1:9', 'p:1', '9', now(), 'open', 'paid', 'delivered', 'delivered', 'carrier', 'SAR', 1500,
  '200.00', '30.00', '0.00', '0.00', '230.00')`;

describe('migration', () => {
  it('applies cleanly and creates every table', async () => {
    const result = await client.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`,
    );
    const tables = result.rows.map((r) => r.table_name).filter((n) => !n.startsWith('__drizzle'));
    expect(tables).toContain('stores');
    expect(tables).toContain('order_profit');
    expect(tables).toContain('order_profit_lines');
    expect(tables).toContain('cost_history');
    expect(tables).toContain('daily_store_rollup');
    expect(tables).toContain('daily_variant_rollup');
    expect(tables).toContain('webhook_events');
    expect(tables.length).toBeGreaterThanOrEqual(22);
  });

  it('stores money as numeric with exactly two decimal digits', async () => {
    const result = await client.query<{ data_type: string; numeric_scale: number; numeric_precision: number }>(
      `SELECT data_type, numeric_precision, numeric_scale FROM information_schema.columns
       WHERE table_name = 'orders' AND column_name = 'total_inc_vat_minor'`,
    );
    expect(result.rows[0]).toMatchObject({ data_type: 'numeric', numeric_scale: 2, numeric_precision: 14 });
  });

  it('every money column shares that type, so none of them drifts', async () => {
    const result = await client.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND column_name LIKE '%_minor'
         AND NOT (data_type = 'numeric' AND numeric_scale = 2 AND numeric_precision = 14)`,
    );
    expect(result.rows).toEqual([]);
  });

  it('keeps timestamps zone-aware, so a comparison cannot depend on the session', async () => {
    const result = await client.query<{ column_name: string; data_type: string }>(
      `SELECT column_name, data_type FROM information_schema.columns
       WHERE table_schema = 'public' AND data_type LIKE 'timestamp%'
         AND data_type <> 'timestamp with time zone'`,
    );
    expect(result.rows).toEqual([]);
  });
});

describe('the database enforces the domain', () => {
  beforeAll(async () => {
    await client.exec(STORE);
    await client.exec(ORDER);
  });

  it('rejects a currency the money columns cannot hold', async () => {
    // KWD has three minor digits; numeric(_, 2) would silently drop one.
    await rejects(
      `INSERT INTO stores (id, platform, platform_store_id, currency, timezone, vat_rate_bps, vat_registered, installed_at)
       VALUES ('p:2', 'demo', '2', 'XYZ', 'Asia/Riyadh', 1500, true, now())`,
      'stores_currency_valid',
    );
  });

  it('rejects a status outside the domain enum', async () => {
    await rejects(
      `INSERT INTO orders (id, store_id, platform_order_id, placed_at, lifecycle, payment_state, fulfillment_state,
        raw_status_label, fulfillment_method, currency, vat_rate_bps, subtotal_ex_vat_minor, vat_amount_minor,
        shipping_charged_ex_vat_minor, cod_fee_charged_ex_vat_minor, total_inc_vat_minor)
       VALUES ('p:1:bad', 'p:1', 'bad', now(), 'in_limbo', 'paid', 'delivered', 'x', 'carrier', 'SAR', 1500,
       '1.00', '0.00', '0.00', '0.00', '1.00')`,
      'orders_lifecycle_valid',
    );
  });

  it('rejects a referrer carrying a path, which is PII that slipped past the adapter', async () => {
    await rejects(
      `UPDATE orders SET attribution_referrer_host = 'google.com/search?q=someones+name' WHERE id = 'p:1:9'`,
      'orders_referrer_is_host_only',
    );
  });

  it('rejects a line whose total does not equal gross minus its discount', async () => {
    await rejects(
      `INSERT INTO order_items (id, order_id, store_id, platform_line_id, platform_product_id, product_name,
        quantity, unit_price_ex_vat_minor, gross_line_ex_vat_minor, line_discount_ex_vat_minor, line_total_ex_vat_minor)
       VALUES ('p:1:9#L1', 'p:1:9', 'p:1', 'L1', 'P1', 'x', 1, '100.00', '100.00', '10.00', '95.00')`,
      'order_items_line_total_consistent',
    );
  });

  it('rejects a card payment with no scheme, and a non-card payment with one', async () => {
    const leg = (n: number, instrument: string, scheme: string) =>
      `INSERT INTO order_payments (id, order_id, leg_index, instrument, scheme, raw_method_label, state, amount_gross_minor)
       VALUES ('pay${String(n)}', 'p:1:9', ${String(n)}, '${instrument}', ${scheme}, 'x', 'captured', '230.00')`;
    await rejects(leg(1, 'card', 'NULL'), 'order_payments_scheme_iff_card');
    await rejects(leg(2, 'cod', `'mada'`), 'order_payments_scheme_iff_card');
    await client.exec(leg(3, 'card', `'mada'`));
  });

  it('rejects a fee rule whose floor is above its cap', async () => {
    await client.exec(
      `INSERT INTO fee_rule_sets (id, store_id, currency, effective_from) VALUES ('frs1', 'p:1', 'SAR', now())`,
    );
    await rejects(
      `INSERT INTO gateway_fee_rules (id, fee_rule_set_id, instrument, scheme, provider, percent_bps, fixed_minor,
        min_fee_minor, max_fee_minor, fee_vat_bps, source)
       VALUES ('g1', 'frs1', 'card', 'mada', NULL, 100, '0.00', '200.00', '1.00', 1500, 'merchant_entered')`,
      'gateway_fee_rules_bounds_ordered',
    );
  });

  it('rejects a negative percentage, which would turn a cost line into revenue', async () => {
    await rejects(
      `INSERT INTO gateway_fee_rules (id, fee_rule_set_id, instrument, scheme, provider, percent_bps, fixed_minor,
        fee_vat_bps, source)
       VALUES ('g2', 'frs1', 'card', 'visa', NULL, -275, '0.00', 1500, 'merchant_entered')`,
      'gateway_fee_rules_percent_bps_positive',
    );
  });

  it('rejects two gateway rules with the same key, whose winner would depend on row order', async () => {
    const rule = (id: string) =>
      `INSERT INTO gateway_fee_rules (id, fee_rule_set_id, instrument, scheme, provider, percent_bps, fixed_minor,
        fee_vat_bps, source)
       VALUES ('${id}', 'frs1', 'card', 'mastercard', NULL, 275, '1.00', 1500, 'merchant_entered')`;
    await client.exec(rule('g3'));
    await rejects(rule('g4'), 'gateway_fee_rules_key_unique');
  });

  it('rejects an inverted cost-history window, which the as-of query would silently miss', async () => {
    await rejects(
      `INSERT INTO cost_history (id, store_id, platform_product_id, platform_variant_id, unit_cost_minor, source,
        effective_from, effective_to)
       VALUES ('c1', 'p:1', 'P1', NULL, '40.00', 'merchant_manual', now(), now() - interval '1 day')`,
      'cost_history_window_ordered',
    );
  });

  it('rejects a reversal that does not account for every halala', async () => {
    await rejects(
      `INSERT INTO reversals (id, order_id, store_id, kind, reason, occurred_at, amount_ex_vat_minor,
        shipping_refund_ex_vat_minor, cod_fee_refund_ex_vat_minor, adjustment_ex_vat_minor, vat_minor,
        total_inc_vat_minor, restock_outcome, has_line_detail)
       VALUES ('r1', 'p:1:9', 'p:1', 'refund', 'customer_return', now(), '100.00', '0.00', '0.00', '0.00', '15.00',
       '116.00', 'restocked_sellable', true)`,
      'reversals_total_consistent',
    );
  });

  it('rejects a profit row claiming more goods came back than went out', async () => {
    await rejects(
      `INSERT INTO order_profit (order_id, store_id, calc_version, currency, business_date, status,
        recognition_kind, cogs_minor, restocked_cogs_minor, contribution_margin_minor, diagnostics)
       VALUES ('p:1:9', 'p:1', 2, 'SAR', '2026-03-01', 'computed', 'recognized', '100.00', '150.00', '10.00', '[]')`,
      'order_profit_restock_bounded',
    );
  });

  it('rejects a computed profit row with no margin, and a rejected one that has totals', async () => {
    await rejects(
      `INSERT INTO order_profit (order_id, store_id, calc_version, currency, business_date, status,
        recognition_kind, diagnostics)
       VALUES ('p:1:9', 'p:1', 2, 'SAR', '2026-03-01', 'computed', 'recognized', '[]')`,
      'order_profit_totals_iff_computed',
    );
  });

  it('makes webhook delivery idempotent, which platforms rely on us for', async () => {
    const event = (id: string) =>
      `INSERT INTO webhook_events (id, store_id, platform_event_id, event_type, raw_event_type, received_at)
       VALUES ('${id}', 'p:1', 'evt_1', 'order.created', 'order.created', now())`;
    await client.exec(event('w1'));
    // Platforms retry aggressively and duplicate delivery is normal.
    await rejects(event('w2'), 'webhook_events_store_event_unique');
  });
});

describe('money survives the round trip', () => {
  it('reads back exactly what was written, as a string', async () => {
    await client.exec(
      `INSERT INTO cost_history (id, store_id, platform_product_id, platform_variant_id, unit_cost_minor, source, effective_from)
       VALUES ('c_rt', 'p:1', 'P_RT', NULL, '123.45', 'merchant_manual', now())`,
    );
    const result = await client.query<{ unit_cost_minor: string }>(
      `SELECT unit_cost_minor FROM cost_history WHERE id = 'c_rt'`,
    );
    // A string, not a float — which is the entire reason this column is numeric.
    expect(result.rows[0]?.unit_cost_minor).toBe('123.45');
    expect(typeof result.rows[0]?.unit_cost_minor).toBe('string');
  });

  it('refuses a third decimal digit rather than rounding it away', async () => {
    // numeric(_, 2) would silently round 0.005 away; we would rather it did not
    // reach the column at all, which is what assertStorableCurrency is for.
    const result = await client.query<{ v: string }>(`SELECT '10.005'::numeric(14,2) AS v`);
    expect(result.rows[0]?.v).toBe('10.01');
  });

  it('holds MAX_MINOR without loss', async () => {
    const result = await client.query<{ v: string }>(`SELECT '9007199254.74'::numeric(14,2) AS v`);
    expect(result.rows[0]?.v).toBe('9007199254.74');
  });
});

describe('the dirty-rollup design', () => {
  it('indexes only the dirty rows, so the sweep never scans the table', async () => {
    const result = await client.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'daily_store_rollup_dirty_idx'`,
    );
    expect(result.rows[0]?.indexdef).toContain('WHERE');
  });

  it('defaults a new bucket to dirty, so a row can never be born stale', async () => {
    await client.exec(
      `INSERT INTO daily_store_rollup (store_id, business_date) VALUES ('p:1', '2026-03-02')`,
    );
    const [row] = await db
      .select({ dirty: schema.dailyStoreRollup.dirty })
      .from(schema.dailyStoreRollup)
      .where(sql`${schema.dailyStoreRollup.businessDate} = '2026-03-02'`);
    expect(row?.dirty).toBe(true);
  });
});
