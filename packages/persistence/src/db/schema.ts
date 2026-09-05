import {
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import {
  CARD_SCHEMES,
  COST_SOURCES,
  CURRENCY_CODES,
  DEVICES,
  FULFILLMENT_METHODS,
  FULFILLMENT_STATES,
  ORDER_LIFECYCLES,
  PAYMENT_INSTRUMENTS,
  PAYMENT_LEG_STATES,
  PAYMENT_STATES,
  RESTOCK_OUTCOMES,
  REVERSAL_KINDS,
  REVERSAL_REASONS,
  SHIPMENT_DIRECTIONS,
  SHIPMENT_STATUSES,
} from '@ghalla/contracts';
import { MONEY_PRECISION, MONEY_SCALE } from './money.js';

/**
 * ONE schema, deployed per platform to its own database.
 *
 * Each integration is its own Railway service with its own Postgres. They share
 * this file, not a database — which is why nothing here is keyed by platform:
 * every row in a given database belongs to the same one.
 *
 * Two conventions worth stating before you read on.
 *
 * MONEY is `numeric(14, 2)`, not an integer column. The domain works in integer
 * halalas and this stores the same value with its decimal point where a human
 * expects it; `src/db/money.ts` is the only place the two meet, and it converts
 * digit-wise rather than through a float. Reading one of these columns with
 * `Number()` is a bug.
 *
 * TIMESTAMPS are `timestamptz`. The canonical `Instant` type is UTC-only by
 * construction, and `timestamptz` says so at the database level — a bare
 * `timestamp` compares and casts against whatever the session's TimeZone
 * happens to be, which for an audit trail over money is a silent hazard rather
 * than a saved byte.
 */

/** Money. Named so a reader of a column definition does not have to remember the precision. */
const money = (name: string) => numeric(name, { precision: MONEY_PRECISION, scale: MONEY_SCALE });

/** UTC instant. See the note above on why every one of these carries a zone. */
const instant = (name: string) => timestamp(name, { withTimezone: true });

/**
 * Ties a text column to a domain enum, so the database rejects what the types
 * reject. The values come from the frozen const tuples in `@ghalla/contracts`,
 * which is the same source `z.enum()` and every adapter lookup table use — so
 * there is one list, not four. `sql.raw` is safe here because these are
 * compile-time constants from our own package, never input.
 */
const oneOf = (column: AnyPgColumn, values: readonly string[]) =>
  sql`${column} IN (${sql.raw(values.map((v) => `'${v}'`).join(', '))})`;

const nonNegative = (column: AnyPgColumn) => sql`${column} >= 0`;

// ───────────────────────────────────────────────────────────── tenancy ─────

export const stores = pgTable(
  'stores',
  {
    // Derived, never minted: `${platform}:${platformStoreId}`. Webhook delivery
    // is at-least-once, so an id the database chose would differ per arrival.
    id: text('id').primaryKey(),
    // Adapter-supplied slug. Deliberately not an enum: a union of platform names
    // in the shared layer is the thing this architecture exists to prevent.
    platform: text('platform').notNull(),
    // The identifier the platform itself uses for this store.
    platformStoreId: text('platform_store_id').notNull(),
    currency: text('currency').notNull(),
    // IANA zone. Owns the business-date boundary for every rollup, which is why
    // a store in Riyadh does not see its evening orders filed under tomorrow.
    timezone: text('timezone').notNull(),
    // Integer basis points. 1500 for Saudi Arabia. Never a 0.15 float.
    vatRateBps: integer('vat_rate_bps').notNull(),
    // Distinct from a zero rate, and worth real money: an unregistered merchant
    // cannot reclaim the VAT on their processor and courier invoices, so it is a
    // permanent cost that belongs inside their margin.
    vatRegistered: boolean('vat_registered').notNull(),
    installedAt: instant('installed_at').notNull(),
    // Set when the app is uninstalled. Rows are kept for the reinstall case;
    // ingestion must skip a store that has one.
    uninstalledAt: instant('uninstalled_at'),
    createdAt: instant('created_at').defaultNow().notNull(),
    updatedAt: instant('updated_at').defaultNow().notNull(),
  },
  (table) => [
    unique('stores_platform_store_unique').on(table.platform, table.platformStoreId),
    index('stores_platform_idx').on(table.platform),
    check('stores_currency_valid', oneOf(table.currency, CURRENCY_CODES)),
    check('stores_vat_rate_range', sql`${table.vatRateBps} >= 0 AND ${table.vatRateBps} <= 10000`),
  ],
);

export const platformCredentials = pgTable(
  'platform_credentials',
  {
    storeId: text('store_id')
      .primaryKey()
      .references(() => stores.id, { onDelete: 'cascade' }),
    // The adapter's own key set, encrypted as one blob. Opaque on purpose: one
    // platform issues three secrets and sends the same value under two different
    // header names, which no named-column layout can hold.
    secretsEncrypted: text('secrets_encrypted').notNull(),
    // Which key encrypted the blob, so a rotation can find what to re-wrap.
    encryptionKeyId: text('encryption_key_id').notNull(),
    // Absolute instants only. One platform reports expiry as a DURATION from its
    // token endpoint and an EPOCH from its install webhook, under the same field
    // name; the adapter resolves that, and this column cannot carry the ambiguity.
    expiresAt: instant('expires_at'),
    // Refresh tokens expire too, and where they are single-use and rotating a
    // store that goes quiet needs the merchant to reconnect. The refresh
    // scheduler is platform-agnostic and cannot know that without this.
    refreshExpiresAt: instant('refresh_expires_at'),
    // Set when the platform rejected a refresh. The merchant must reconnect;
    // retrying is what turns one dead token into a rate-limit ban.
    reauthRequiredAt: instant('reauth_required_at'),
    createdAt: instant('created_at').defaultNow().notNull(),
    updatedAt: instant('updated_at').defaultNow().notNull(),
  },
  (table) => [
    // The refresh cron's only query: whose token expires soonest.
    index('platform_credentials_expires_idx').on(table.expiresAt),
  ],
);

// ─────────────────────────────────────────────────────────── ingestion ─────

export const webhookEvents = pgTable(
  'webhook_events',
  {
    id: text('id').primaryKey(),
    storeId: text('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'cascade' }),
    // The adapter's dedupe key, stable across redeliveries of one event. NOT a
    // payload hash: a retried delivery of the same event may differ byte for
    // byte, which would make a hash look like a new event every time.
    platformEventId: text('platform_event_id').notNull(),
    // Normalized event type. The platform's own name is kept beside it because
    // an unrecognized value must be triageable, not just counted.
    eventType: text('event_type').notNull(),
    rawEventType: text('raw_event_type').notNull(),
    receivedAt: instant('received_at').notNull(),
    processedAt: instant('processed_at'),
    // pending | processing | processed | failed | skipped
    status: text('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    // Kept for replay and triage only. Contains platform PII, so it is never
    // read into a canonical type and must be purged on the retention schedule —
    // the whole reason `Ingested<T>` lives behind its own entry point.
    rawPayload: jsonb('raw_payload'),
    createdAt: instant('created_at').defaultNow().notNull(),
  },
  (table) => [
    // THE idempotency guarantee. Platforms retry aggressively and duplicate
    // delivery is normal, so this index is what makes "process once" true.
    unique('webhook_events_store_event_unique').on(table.storeId, table.platformEventId),
    index('webhook_events_status_idx').on(table.status, table.receivedAt),
    index('webhook_events_store_received_idx').on(table.storeId, table.receivedAt),
    check('webhook_events_attempts_positive', nonNegative(table.attempts)),
    check(
      'webhook_events_status_valid',
      oneOf(table.status, ['pending', 'processing', 'processed', 'failed', 'skipped']),
    ),
  ],
);

/** Resumable per-store cursors, so a 50k-order backfill survives a redeploy. */
export const backfillCursors = pgTable(
  'backfill_cursors',
  {
    storeId: text('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'cascade' }),
    // orders | products — which sweep this cursor belongs to.
    resource: text('resource').notNull(),
    // Opaque to everything but the adapter that minted it.
    cursor: text('cursor'),
    rangeFrom: instant('range_from'),
    rangeTo: instant('range_to'),
    // running | paused | complete | failed
    status: text('status').notNull().default('running'),
    itemsFetched: integer('items_fetched').notNull().default(0),
    lastAdvancedAt: instant('last_advanced_at'),
    createdAt: instant('created_at').defaultNow().notNull(),
    updatedAt: instant('updated_at').defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.storeId, table.resource] }),
    check('backfill_cursors_resource_valid', oneOf(table.resource, ['orders', 'products'])),
    check(
      'backfill_cursors_status_valid',
      oneOf(table.status, ['running', 'paused', 'complete', 'failed']),
    ),
  ],
);

// ─────────────────────────────────────────────────────────── catalogue ─────

export const products = pgTable(
  'products',
  {
    storeId: text('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'cascade' }),
    platformProductId: text('platform_product_id').notNull(),
    // Merchant-entered free text: frequently blank, duplicated across variants
    // and edited in place. A display attribute and a secondary cost key, never
    // the primary one.
    sku: text('sku'),
    productName: text('product_name').notNull(),
    // Cost as the platform reports it — the seed for cost history on day one.
    // A platform's 0 maps to NULL: "free" and "we don't know" must never be the
    // same value, because one of them reports 100% margin.
    platformCostMinor: money('platform_cost_minor'),
    listPriceExVatMinor: money('list_price_ex_vat_minor'),
    active: boolean('active').notNull().default(true),
    platformUpdatedAt: instant('platform_updated_at'),
    createdAt: instant('created_at').defaultNow().notNull(),
    updatedAt: instant('updated_at').defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.storeId, table.platformProductId] }),
    index('products_store_sku_idx').on(table.storeId, table.sku),
    index('products_store_active_idx').on(table.storeId, table.active),
  ],
);

export const variants = pgTable(
  'variants',
  {
    storeId: text('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'cascade' }),
    platformProductId: text('platform_product_id').notNull(),
    platformVariantId: text('platform_variant_id').notNull(),
    sku: text('sku'),
    variantName: text('variant_name').notNull(),
    platformCostMinor: money('platform_cost_minor'),
    listPriceExVatMinor: money('list_price_ex_vat_minor'),
    active: boolean('active').notNull().default(true),
    createdAt: instant('created_at').defaultNow().notNull(),
    updatedAt: instant('updated_at').defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.storeId, table.platformProductId, table.platformVariantId] }),
    index('variants_store_sku_idx').on(table.storeId, table.sku),
  ],
);

/**
 * Cost history, slowly-changing dimension type 2.
 *
 * Keyed on the PRODUCT KEY — store + platform product + platform variant — and
 * not on SKU, because SKU is merchant-entered text that gets reused after a
 * deletion and edited in place, which would merge unrelated products and make a
 * product's whole history jump the day someone tidies the catalogue.
 *
 * `effectiveTo` NULL means "still current". A correction closes the open row
 * and opens a new one; it never updates in place, because a merchant editing a
 * cost today must not silently change last quarter's profit.
 */
export const costHistory = pgTable(
  'cost_history',
  {
    id: text('id').primaryKey(),
    storeId: text('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'cascade' }),
    platformProductId: text('platform_product_id').notNull(),
    // NULL for a product-level cost that applies to every variant.
    platformVariantId: text('platform_variant_id'),
    sku: text('sku'),
    // The merchant's true NET CASH cost per unit: net of recoverable input VAT
    // when the store is VAT-registered, gross when it is not. The same
    // convention carrier cost uses, and the only one a merchant types by hand.
    unitCostMinor: money('unit_cost_minor').notNull(),
    source: text('source').notNull(),
    effectiveFrom: instant('effective_from').notNull(),
    // NULL = open. The half-open window [from, to) is what the as-of query reads.
    effectiveTo: instant('effective_to'),
    // Who or what closed the previous row, for the audit trail a cost correction
    // has to leave behind.
    supersedesId: text('supersedes_id'),
    note: text('note'),
    createdAt: instant('created_at').defaultNow().notNull(),
  },
  (table) => [
    // THE as-of query: cost for this product key at this instant. Ordered so the
    // planner can walk straight to the row whose window contains `placedAt`.
    index('cost_history_asof_idx').on(
      table.storeId,
      table.platformProductId,
      table.platformVariantId,
      table.effectiveFrom,
    ),
    index('cost_history_open_idx')
      .on(table.storeId, table.platformProductId, table.platformVariantId)
      .where(sql`${table.effectiveTo} IS NULL`),
    index('cost_history_sku_idx').on(table.storeId, table.sku),
    check('cost_history_source_valid', oneOf(table.source, COST_SOURCES)),
    check('cost_history_cost_positive', nonNegative(table.unitCostMinor)),
    // An inverted window would make the as-of query return nothing, silently.
    check(
      'cost_history_window_ordered',
      sql`${table.effectiveTo} IS NULL OR ${table.effectiveTo} > ${table.effectiveFrom}`,
    ),
  ],
);

// ──────────────────────────────────────────────────────────── fee rules ────

/**
 * A versioned set of rules, identified so that publishing new rates is a
 * TARGETED recompute of the orders that used the old set rather than a full
 * rebuild of the store.
 */
export const feeRuleSets = pgTable(
  'fee_rule_sets',
  {
    id: text('id').primaryKey(),
    storeId: text('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'cascade' }),
    currency: text('currency').notNull(),
    effectiveFrom: instant('effective_from').notNull(),
    effectiveTo: instant('effective_to'),
    note: text('note'),
    createdAt: instant('created_at').defaultNow().notNull(),
  },
  (table) => [
    index('fee_rule_sets_asof_idx').on(table.storeId, table.effectiveFrom),
    check('fee_rule_sets_currency_valid', oneOf(table.currency, CURRENCY_CODES)),
    check(
      'fee_rule_sets_window_ordered',
      sql`${table.effectiveTo} IS NULL OR ${table.effectiveTo} > ${table.effectiveFrom}`,
    ),
  ],
);

/** Columns every fee-like rule shares, because they are the same arithmetic with different keys. */
const feeFormulaColumns = {
  percentBps: integer('percent_bps').notNull(),
  fixedMinor: money('fixed_minor').notNull(),
  // Couriers quote a percentage with a floor; domestic debit is capped per
  // transaction. Uncapped, every high-value order is overcharged.
  minFeeMinor: money('min_fee_minor'),
  maxFeeMinor: money('max_fee_minor'),
  // Saudi law taxes explicit fees and commissions, so omitting this understates
  // gateway cost by 15% on every card order, uniformly, in the flattering
  // direction.
  feeVatBps: integer('fee_vat_bps').notNull(),
  // Whether the merchant's quoted rate already includes that VAT. Without it a
  // 2.75% inclusive quote is indistinguishable from a 2.75% exclusive one.
  ratesIncludeVat: boolean('rates_include_vat').notNull().default(false),
  // merchant_entered | gateway_statement | default_table. Feeds the confidence
  // term: a published default is not the same fact as a merchant's contract.
  source: text('source').notNull(),
};

const FEE_SOURCES = ['merchant_entered', 'gateway_statement', 'default_table'] as const;

/** Shared constraints, so a bad rate card is rejected by the database too, not only by the engine. */
const feeFormulaChecks = (table: {
  percentBps: AnyPgColumn;
  fixedMinor: AnyPgColumn;
  minFeeMinor: AnyPgColumn;
  maxFeeMinor: AnyPgColumn;
  feeVatBps: AnyPgColumn;
  source: AnyPgColumn;
}, prefix: string) => [
  check(`${prefix}_percent_bps_positive`, nonNegative(table.percentBps)),
  check(`${prefix}_fixed_positive`, nonNegative(table.fixedMinor)),
  check(`${prefix}_fee_vat_range`, sql`${table.feeVatBps} >= 0 AND ${table.feeVatBps} <= 10000`),
  // A transposed floor and cap silently invents margin, because the clamp
  // applies the floor and then lets the cap win.
  check(
    `${prefix}_bounds_ordered`,
    sql`${table.minFeeMinor} IS NULL OR ${table.maxFeeMinor} IS NULL OR ${table.minFeeMinor} <= ${table.maxFeeMinor}`,
  ),
  check(`${prefix}_source_valid`, oneOf(table.source, FEE_SOURCES)),
];

export const gatewayFeeRules = pgTable(
  'gateway_fee_rules',
  {
    id: text('id').primaryKey(),
    feeRuleSetId: text('fee_rule_set_id')
      .notNull()
      .references(() => feeRuleSets.id, { onDelete: 'cascade' }),
    // NULL matches anything. Specificity decides: instrument + scheme +
    // provider beats instrument + scheme beats instrument alone.
    instrument: text('instrument'),
    scheme: text('scheme'),
    // Open slug, not an enum: the same domestic debit transaction is priced
    // differently by every processor, and rates are individually negotiated.
    provider: text('provider'),
    ...feeFormulaColumns,
    createdAt: instant('created_at').defaultNow().notNull(),
  },
  (table) => [
    // Two rules with one key means which applies depends on row order — a 2.75x
    // swing in the fee decided by the caller's ORDER BY.
    //
    // `nullsNotDistinct` is load-bearing, not a flourish. A plain UNIQUE treats
    // every NULL as distinct, so two rules that both leave `provider` unset —
    // the ordinary case — would not collide, and this constraint would guard
    // only the rules least likely to be duplicated.
    unique('gateway_fee_rules_key_unique')
      .on(table.feeRuleSetId, table.instrument, table.scheme, table.provider)
      .nullsNotDistinct(),
    index('gateway_fee_rules_set_idx').on(table.feeRuleSetId),
    check(
      'gateway_fee_rules_instrument_valid',
      sql`${table.instrument} IS NULL OR ${oneOf(table.instrument, PAYMENT_INSTRUMENTS)}`,
    ),
    check(
      'gateway_fee_rules_scheme_valid',
      sql`${table.scheme} IS NULL OR ${oneOf(table.scheme, CARD_SCHEMES)}`,
    ),
    ...feeFormulaChecks(table, 'gateway_fee_rules'),
  ],
);

export const codFeeRules = pgTable(
  'cod_fee_rules',
  {
    id: text('id').primaryKey(),
    feeRuleSetId: text('fee_rule_set_id')
      .notNull()
      .references(() => feeRuleSets.id, { onDelete: 'cascade' }),
    // Keyed by CARRIER. Couriers publish cash handling as a fixed amount plus a
    // percentage, and the rate differs between two couriers one store uses on
    // the same day — which a store-level constant cannot express at all.
    carrier: text('carrier'),
    ...feeFormulaColumns,
    createdAt: instant('created_at').defaultNow().notNull(),
  },
  (table) => [
    // See the note on gateway_fee_rules_key_unique: a null carrier is the
    // catch-all row, so it is exactly the one that must not be duplicated.
    unique('cod_fee_rules_key_unique').on(table.feeRuleSetId, table.carrier).nullsNotDistinct(),
    index('cod_fee_rules_set_idx').on(table.feeRuleSetId),
    ...feeFormulaChecks(table, 'cod_fee_rules'),
  ],
);

export const shippingFallbackRules = pgTable(
  'shipping_fallback_rules',
  {
    id: text('id').primaryKey(),
    feeRuleSetId: text('fee_rule_set_id')
      .notNull()
      .references(() => feeRuleSets.id, { onDelete: 'cascade' }),
    // A row with every key NULL is a legitimate configuration, not a degenerate
    // one: it is the single blended per-shipment number a merchant types at
    // onboarding, and a per-region row simply outranks it later.
    countryCode: text('country_code'),
    region: text('region'),
    carrier: text('carrier'),
    // outbound | return | any. A filter rather than a score, because a return
    // leg genuinely prices differently and must not lose to a country rule.
    direction: text('direction').notNull().default('any'),
    costMinor: money('cost_minor').notNull(),
    createdAt: instant('created_at').defaultNow().notNull(),
  },
  (table) => [
    // The blended catch-all row has every key null, so without
    // `nullsNotDistinct` a merchant could end up with two of them.
    unique('shipping_fallback_rules_key_unique')
      .on(table.feeRuleSetId, table.countryCode, table.region, table.carrier, table.direction)
      .nullsNotDistinct(),
    index('shipping_fallback_rules_set_idx').on(table.feeRuleSetId),
    check('shipping_fallback_rules_cost_positive', nonNegative(table.costMinor)),
    check(
      'shipping_fallback_rules_direction_valid',
      oneOf(table.direction, [...SHIPMENT_DIRECTIONS, 'any']),
    ),
  ],
);

// ────────────────────────────────────────────────────────────── orders ─────

export const orders = pgTable(
  'orders',
  {
    // Derived: `${storeId}:${platformOrderId}`. Never a sequence and never a
    // random UUID — webhook delivery is at-least-once, and an id chosen here
    // would differ on every arrival and double-count the largest cost lines.
    id: text('id').primaryKey(),
    storeId: text('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'cascade' }),
    platformOrderId: text('platform_order_id').notNull(),
    placedAt: instant('placed_at').notNull(),
    platformUpdatedAt: instant('platform_updated_at'),

    // Three orthogonal axes, not one status. "Shipped" and "refunded" are not
    // mutually exclusive, "cancelled" says nothing about whether money was
    // captured, and a refused cash-on-delivery parcel needs all three to be
    // distinguishable from a completed sale.
    lifecycle: text('lifecycle').notNull(),
    paymentState: text('payment_state').notNull(),
    fulfillmentState: text('fulfillment_state').notNull(),
    // Merchants define custom statuses, so the normalized axes alone cannot
    // round-trip what the platform said.
    platformStatusId: text('platform_status_id'),
    rawStatusLabel: text('raw_status_label').notNull(),
    isTest: boolean('is_test').notNull().default(false),

    // Gates the shipping fallback, which would otherwise invent a courier charge
    // for a pickup order.
    fulfillmentMethod: text('fulfillment_method').notNull(),
    // Retained under PDPL: city and region are the only input the shipping
    // fallback has, and with carrier cost unavailable from the platforms that
    // fallback is the primary path for the largest cost line in the model.
    destinationCountryCode: text('destination_country_code'),
    destinationRegion: text('destination_region'),
    destinationCity: text('destination_city'),

    currency: text('currency').notNull(),
    // The rate that applied to THIS order, snapshotted at ingestion.
    vatRateBps: integer('vat_rate_bps').notNull(),

    // Net of line-level discounts, GROSS of any order discount not already
    // reflected in the line totals.
    subtotalExVatMinor: money('subtotal_ex_vat_minor').notNull(),
    // TOTAL output VAT: goods AND shipping AND COD fee. Read as goods-only,
    // shipping VAT is unaccounted for and no order ever reconciles.
    vatAmountMinor: money('vat_amount_minor').notNull(),
    shippingChargedExVatMinor: money('shipping_charged_ex_vat_minor').notNull(),
    codFeeChargedExVatMinor: money('cod_fee_charged_ex_vat_minor').notNull(),
    totalIncVatMinor: money('total_inc_vat_minor').notNull(),

    // HMAC of the platform's customer id under a per-store salt held outside
    // this database. Exists only so repeat purchases can be counted; platform
    // customer ids are small sequential integers, so an unsalted hash would be
    // brute-forceable end to end from a dump of this table.
    customerRef: text('customer_ref'),
    attributionDevice: text('attribution_device'),
    // Host only. Path and query carry search terms and identifiers.
    attributionReferrerHost: text('attribution_referrer_host'),

    createdAt: instant('created_at').defaultNow().notNull(),
    updatedAt: instant('updated_at').defaultNow().notNull(),
  },
  (table) => [
    unique('orders_store_platform_order_unique').on(table.storeId, table.platformOrderId),
    // The dashboard's main range scan.
    index('orders_store_placed_idx').on(table.storeId, table.placedAt),
    index('orders_store_updated_idx').on(table.storeId, table.platformUpdatedAt),
    index('orders_customer_ref_idx').on(table.storeId, table.customerRef),
    check('orders_currency_valid', oneOf(table.currency, CURRENCY_CODES)),
    check('orders_lifecycle_valid', oneOf(table.lifecycle, ORDER_LIFECYCLES)),
    check('orders_payment_state_valid', oneOf(table.paymentState, PAYMENT_STATES)),
    check('orders_fulfillment_state_valid', oneOf(table.fulfillmentState, FULFILLMENT_STATES)),
    check('orders_fulfillment_method_valid', oneOf(table.fulfillmentMethod, FULFILLMENT_METHODS)),
    check(
      'orders_device_valid',
      sql`${table.attributionDevice} IS NULL OR ${oneOf(table.attributionDevice, DEVICES)}`,
    ),
    check('orders_vat_rate_range', sql`${table.vatRateBps} >= 0 AND ${table.vatRateBps} <= 10000`),
    // A referrer with a path in it is PII that slipped past the adapter.
    check(
      'orders_referrer_is_host_only',
      sql`${table.attributionReferrerHost} IS NULL OR ${table.attributionReferrerHost} NOT LIKE '%/%'`,
    ),
  ],
);

export const orderItems = pgTable(
  'order_items',
  {
    // Derived: `${orderId}#${platformLineId}`.
    id: text('id').primaryKey(),
    orderId: text('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    storeId: text('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'cascade' }),
    // NEVER the array index of a fetch response. Without stable line identity,
    // re-ingesting the same order with its items in a different order produces a
    // different discount and shipping allocation, and per-SKU margins churn
    // between recomputes.
    platformLineId: text('platform_line_id').notNull(),
    platformProductId: text('platform_product_id').notNull(),
    // Nullable by necessity: some platforms expose no variant identity on order
    // lines at all, only the SKU.
    platformVariantId: text('platform_variant_id'),
    sku: text('sku'),
    // NOT `name`. That key is on the compile-time PII deny-list, and this is the
    // one legitimate name in the model.
    productName: text('product_name').notNull(),
    quantity: integer('quantity').notNull(),
    unitPriceExVatMinor: money('unit_price_ex_vat_minor').notNull(),
    grossLineExVatMinor: money('gross_line_ex_vat_minor').notNull(),
    lineDiscountExVatMinor: money('line_discount_ex_vat_minor').notNull(),
    // AUTHORITATIVE line revenue. The engine must never recompute this as
    // unit price × quantity.
    lineTotalExVatMinor: money('line_total_ex_vat_minor').notNull(),

    // THE COST SNAPSHOT, resolved once at ingestion and never joined live. This
    // is what makes "a merchant editing a cost today must not silently change
    // last quarter's profit" true: a correction opens a new cost_history row and
    // triggers an explicit, audited recompute, rather than changing this one.
    costAtTimeMinor: money('cost_at_time_minor'),
    costSource: text('cost_source').notNull().default('none'),
    costHistoryId: text('cost_history_id').references(() => costHistory.id, { onDelete: 'set null' }),

    createdAt: instant('created_at').defaultNow().notNull(),
    updatedAt: instant('updated_at').defaultNow().notNull(),
  },
  (table) => [
    unique('order_items_order_line_unique').on(table.orderId, table.platformLineId),
    index('order_items_order_idx').on(table.orderId),
    // Per-product rollups walk this.
    index('order_items_product_idx').on(table.storeId, table.platformProductId, table.platformVariantId),
    index('order_items_sku_idx').on(table.storeId, table.sku),
    check('order_items_quantity_positive', nonNegative(table.quantity)),
    check('order_items_cost_source_valid', oneOf(table.costSource, COST_SOURCES)),
    // The identity the engine asserts, enforced at write time too.
    check(
      'order_items_line_total_consistent',
      sql`${table.lineTotalExVatMinor} = ${table.grossLineExVatMinor} - ${table.lineDiscountExVatMinor}`,
    ),
  ],
);

export const orderPayments = pgTable(
  'order_payments',
  {
    id: text('id').primaryKey(),
    orderId: text('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    // Adapters emit legs in a canonical order, so "the second payment" means the
    // same leg across re-ingests.
    legIndex: integer('leg_index').notNull(),
    // The rail. Kept separate from the scheme and the wallet on purpose: a
    // single `method` enum makes a card network and a presentment wrapper peers
    // of a rail, and a wallet order then prices ~3x wrong with the axis that
    // would have fixed it already discarded.
    instrument: text('instrument').notNull(),
    scheme: text('scheme'),
    wallet: text('wallet'),
    provider: text('provider'),
    rawMethodLabel: text('raw_method_label').notNull(),
    state: text('state').notNull(),
    // VAT-INCLUSIVE amount actually taken from the customer. Named for its basis
    // because every neighbouring column is ex-VAT, and a bare `amount` invites
    // an ex-VAT value and a uniform 15% fee understatement.
    amountGrossMinor: money('amount_gross_minor').notNull(),
    // The only join key to a future settlement line.
    transactionRef: text('transaction_ref'),
    createdAt: instant('created_at').defaultNow().notNull(),
  },
  (table) => [
    unique('order_payments_order_leg_unique').on(table.orderId, table.legIndex),
    index('order_payments_order_idx').on(table.orderId),
    index('order_payments_transaction_ref_idx').on(table.transactionRef),
    check('order_payments_instrument_valid', oneOf(table.instrument, PAYMENT_INSTRUMENTS)),
    check('order_payments_state_valid', oneOf(table.state, PAYMENT_LEG_STATES)),
    // A scheme is required for a card and meaningless for anything else.
    check(
      'order_payments_scheme_iff_card',
      sql`(${table.instrument} = 'card') = (${table.scheme} IS NOT NULL)`,
    ),
    check(
      'order_payments_scheme_valid',
      sql`${table.scheme} IS NULL OR ${oneOf(table.scheme, CARD_SCHEMES)}`,
    ),
  ],
);

export const orderDiscounts = pgTable(
  'order_discounts',
  {
    id: text('id').primaryKey(),
    orderId: text('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    discountIndex: integer('discount_index').notNull(),
    code: text('code'),
    // items | shipping | cod_fee — which term this reduces.
    target: text('target').notNull(),
    // TRUE means the platform already deducted it from the target's amount, so
    // the engine ignores it. Without this column an order-level coupon either
    // inflates revenue by its full value or, once someone "fixes" that, deflates
    // it by the same amount — and nothing would say which.
    reflectedInComponent: boolean('reflected_in_component').notNull(),
    amountExVatMinor: money('amount_ex_vat_minor').notNull(),
    createdAt: instant('created_at').defaultNow().notNull(),
  },
  (table) => [
    unique('order_discounts_order_index_unique').on(table.orderId, table.discountIndex),
    index('order_discounts_order_idx').on(table.orderId),
    check('order_discounts_target_valid', oneOf(table.target, ['items', 'shipping', 'cod_fee'])),
    check('order_discounts_amount_positive', nonNegative(table.amountExVatMinor)),
  ],
);

// ─────────────────────────────────────────────────────────── shipments ─────

export const shipments = pgTable(
  'shipments',
  {
    // A shipment needs identity for the same reason an order does: the engine
    // sums carrier cost across shipments, and without a key, webhook replay
    // double-counts the largest cost line in the model.
    id: text('id').primaryKey(),
    orderId: text('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    storeId: text('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'cascade' }),
    platformShipmentId: text('platform_shipment_id').notNull(),
    direction: text('direction').notNull(),
    // `returned_to_origin` is how an RTO becomes detectable from the shipment
    // record at all, and RTO impact is a headline deliverable.
    status: text('status').notNull(),
    carrier: text('carrier').notNull(),
    rawCarrierLabel: text('raw_carrier_label').notNull(),
    // What the courier actually billed, or NULL when unreported — which is
    // essentially always, because neither platform in scope exposes it to a
    // general merchant app. The fallback rule is the primary path here.
    //
    // Convention: the merchant's true net cash cost. Deliberately not named
    // ExVat, because for an unregistered merchant the VAT on that invoice is a
    // permanent cost that belongs inside the number.
    carrierCostMinor: money('carrier_cost_minor'),
    shippedAt: instant('shipped_at'),
    deliveredAt: instant('delivered_at'),
    platformUpdatedAt: instant('platform_updated_at'),
    createdAt: instant('created_at').defaultNow().notNull(),
    updatedAt: instant('updated_at').defaultNow().notNull(),
  },
  (table) => [
    unique('shipments_store_platform_shipment_unique').on(table.storeId, table.platformShipmentId),
    index('shipments_order_idx').on(table.orderId),
    index('shipments_store_status_idx').on(table.storeId, table.status),
    check('shipments_direction_valid', oneOf(table.direction, SHIPMENT_DIRECTIONS)),
    check('shipments_status_valid', oneOf(table.status, SHIPMENT_STATUSES)),
  ],
);

/**
 * Which lines travelled in which parcel.
 *
 * Read by the engine: revenue share is ANTI-correlated with freight in split
 * fulfilment — a heavy cheap item and a light expensive one — so allocating by
 * revenue gets a SKU's margin sign wrong. Empty means the platform did not
 * report the mapping, and the engine falls back to an order-wide split.
 */
export const shipmentLines = pgTable(
  'shipment_lines',
  {
    shipmentId: text('shipment_id')
      .notNull()
      .references(() => shipments.id, { onDelete: 'cascade' }),
    orderItemId: text('order_item_id')
      .notNull()
      .references(() => orderItems.id, { onDelete: 'cascade' }),
    quantity: integer('quantity').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.shipmentId, table.orderItemId] }),
    index('shipment_lines_order_item_idx').on(table.orderItemId),
    check('shipment_lines_quantity_positive', nonNegative(table.quantity)),
  ],
);

// ─────────────────────────────────────────────────────────── reversals ─────

/**
 * Money flowing back to the customer. Named a reversal, not a refund, because it
 * also covers voids and chargebacks.
 *
 * A return to origin is NOT here: no money moved, so a zero-amount row would be
 * a phantom record. An RTO is expressed on the order — unpaid plus a `rto`
 * fulfilment state — with its return leg as a shipment.
 */
export const reversals = pgTable(
  'reversals',
  {
    id: text('id').primaryKey(),
    orderId: text('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    storeId: text('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'cascade' }),
    // NULL where the platform has no refund entity and a refund is discovered by
    // diffing order state; the id is then derived so a redelivery cannot
    // subtract the same money twice.
    platformReversalId: text('platform_reversal_id'),
    kind: text('kind').notNull(),
    reason: text('reason').notNull(),
    rawReasonLabel: text('raw_reason_label'),
    occurredAt: instant('occurred_at').notNull(),

    // Item revenue reversed, excluding VAT. A single gross scalar here would be
    // a 15% error on every refund.
    amountExVatMinor: money('amount_ex_vat_minor').notNull(),
    shippingRefundExVatMinor: money('shipping_refund_ex_vat_minor').notNull(),
    codFeeRefundExVatMinor: money('cod_fee_refund_ex_vat_minor').notNull(),
    // Value attributable to no line — a goodwill gesture or a price adjustment.
    // Without a slot for it the totals identity cannot close and adapters smear
    // goodwill across SKUs that did nothing wrong.
    adjustmentExVatMinor: money('adjustment_ex_vat_minor').notNull(),
    vatMinor: money('vat_minor').notNull(),
    totalIncVatMinor: money('total_inc_vat_minor').notNull(),

    // Fallback used only when the platform reported no line detail.
    restockOutcome: text('restock_outcome').notNull(),
    // FALSE means the platform gave no line breakdown, so the engine allocated
    // by revenue share and must say so rather than claiming it was reported.
    hasLineDetail: boolean('has_line_detail').notNull(),
    platformUpdatedAt: instant('platform_updated_at'),
    createdAt: instant('created_at').defaultNow().notNull(),
  },
  (table) => [
    index('reversals_order_idx').on(table.orderId),
    index('reversals_store_occurred_idx').on(table.storeId, table.occurredAt),
    check('reversals_kind_valid', oneOf(table.kind, REVERSAL_KINDS)),
    check('reversals_reason_valid', oneOf(table.reason, REVERSAL_REASONS)),
    check('reversals_restock_valid', oneOf(table.restockOutcome, RESTOCK_OUTCOMES)),
    // Every halala accounted for. The engine warns on a mismatch; the database
    // refuses to store one in the first place.
    check(
      'reversals_total_consistent',
      sql`${table.totalIncVatMinor} = ${table.amountExVatMinor} + ${table.shippingRefundExVatMinor} + ${table.codFeeRefundExVatMinor} + ${table.adjustmentExVatMinor} + ${table.vatMinor}`,
    ),
  ],
);

export const reversalLines = pgTable(
  'reversal_lines',
  {
    reversalId: text('reversal_id')
      .notNull()
      .references(() => reversals.id, { onDelete: 'cascade' }),
    orderItemId: text('order_item_id')
      .notNull()
      .references(() => orderItems.id, { onDelete: 'cascade' }),
    quantity: integer('quantity').notNull(),
    amountExVatMinor: money('amount_ex_vat_minor').notNull(),
    // Per line, because one line of a multi-line return comes back sellable
    // while another is damaged — and at refund time the goods are usually still
    // in transit, so a boolean would default to false and understate margin.
    restockOutcome: text('restock_outcome').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.reversalId, table.orderItemId] }),
    index('reversal_lines_order_item_idx').on(table.orderItemId),
    check('reversal_lines_quantity_positive', nonNegative(table.quantity)),
    check('reversal_lines_restock_valid', oneOf(table.restockOutcome, RESTOCK_OUTCOMES)),
  ],
);

// ────────────────────────────────────────────────────────────── profit ─────

/**
 * The materialized result, stamped with the version of the arithmetic that
 * produced it. The only query ever run against `calcVersion` is
 * `WHERE calc_version < $current`, which is what a recompute sweep walks.
 */
export const orderProfit = pgTable(
  'order_profit',
  {
    orderId: text('order_id')
      .primaryKey()
      .references(() => orders.id, { onDelete: 'cascade' }),
    storeId: text('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'cascade' }),
    calcVersion: integer('calc_version').notNull(),
    // Which rule set produced the fee numbers, so republishing rates is a
    // targeted recompute rather than a full rebuild.
    feeRuleSetId: text('fee_rule_set_id').references(() => feeRuleSets.id, { onDelete: 'set null' }),
    // NULL on a rejected row. The engine rejected before it computed either, and
    // writing a literal 'SAR' and 1970-01-01 put two false statements in a money
    // table — every dead-lettered order of an AED store labelled SAR, and every
    // one of them returned by a date-range query for 1970.
    currency: text('currency'),
    // STORE-LOCAL. Riyadh is UTC+3 and volume skews to late evening, so UTC
    // bucketing would file every order after 21:00 local under the next day and
    // Ghalla's "yesterday" would disagree with the merchant's own dashboard.
    // Denormalized here so a fact arriving days late invalidates the ORDER's
    // bucket rather than today's.
    businessDate: date('business_date', { mode: 'string' }),

    // computed | rejected. A rejected row carries no totals: a margin is
    // structurally unavailable on that branch.
    status: text('status').notNull(),
    // recognized | cost_only | excluded, plus the reason.
    recognitionKind: text('recognition_kind').notNull(),
    recognitionReason: text('recognition_reason'),

    itemsRevenueExVatMinor: money('items_revenue_ex_vat_minor'),
    shippingRevenueExVatMinor: money('shipping_revenue_ex_vat_minor'),
    codFeeRevenueExVatMinor: money('cod_fee_revenue_ex_vat_minor'),
    orderDiscountExVatMinor: money('order_discount_ex_vat_minor'),
    revenueExVatMinor: money('revenue_ex_vat_minor'),
    // Reported for reconciliation against the merchant's own dashboard. NEVER
    // deducted: VAT is pass-through.
    vatCollectedMinor: money('vat_collected_minor'),

    cogsMinor: money('cogs_minor'),
    outboundShippingCostMinor: money('outbound_shipping_cost_minor'),
    // Its own term, not folded into the refund impact — a return to origin has
    // no reversal to hang its cost on, and folding it there made the single
    // largest Saudi loss case structurally invisible.
    returnShippingCostMinor: money('return_shipping_cost_minor'),
    gatewayFeeExVatMinor: money('gateway_fee_ex_vat_minor'),
    gatewayFeeVatMinor: money('gateway_fee_vat_minor'),
    gatewayFeeCostMinor: money('gateway_fee_cost_minor'),
    codCostExVatMinor: money('cod_cost_ex_vat_minor'),
    codCostVatMinor: money('cod_cost_vat_minor'),
    codCostMinor: money('cod_cost_minor'),

    reversedRevenueExVatMinor: money('reversed_revenue_ex_vat_minor'),
    restockedCogsMinor: money('restocked_cogs_minor'),
    reversalImpactMinor: money('reversal_impact_minor'),

    contributionMarginMinor: money('contribution_margin_minor'),
    // NULL when revenue is zero or negative: a ratio to nothing is nothing.
    marginBps: integer('margin_bps'),
    // The coverage NUMERATOR, never a ratio. Ratios do not aggregate: an average
    // of per-order percentages is not the store's percentage unless every rollup
    // remembers to weight it, and the one that forgets is unfalsifiably wrong.
    costCoveredRevenueExVatMinor: money('cost_covered_revenue_ex_vat_minor'),

    // Per-term provenance, plus the derived level the dashboard indexes on.
    confidence: jsonb('confidence'),
    // Codes only. The merchant-facing copy is Arabic and comes from translation,
    // so an English string baked in here would be unusable.
    diagnostics: jsonb('diagnostics').notNull(),
    computedAt: instant('computed_at').defaultNow().notNull(),
  },
  (table) => [
    index('order_profit_store_date_idx').on(table.storeId, table.businessDate),
    // The recompute sweep: everything below the current version.
    index('order_profit_calc_version_idx').on(table.storeId, table.calcVersion),
    index('order_profit_fee_rule_set_idx').on(table.feeRuleSetId),
    // Loss-maker ranking reads this. `level` lives inside the confidence JSON,
    // so it is extracted here for an index that a partial scan can use.
    index('order_profit_margin_idx').on(table.storeId, table.contributionMarginMinor),
    check('order_profit_status_valid', oneOf(table.status, ['computed', 'rejected'])),
    check(
      'order_profit_recognition_valid',
      oneOf(table.recognitionKind, ['recognized', 'cost_only', 'excluded']),
    ),
    // A rejected row has no totals, and a computed one must have them.
    check(
      'order_profit_totals_iff_computed',
      sql`(${table.status} = 'computed') = (${table.contributionMarginMinor} IS NOT NULL)`,
    ),
    // The same rule for the two fields the engine only knows once it computes.
    check(
      'order_profit_currency_iff_computed',
      sql`(${table.status} = 'computed') = (${table.currency} IS NOT NULL AND ${table.businessDate} IS NOT NULL)`,
    ),
    // You cannot get back more goods than you shipped.
    check(
      'order_profit_restock_bounded',
      sql`${table.restockedCogsMinor} IS NULL OR ${table.restockedCogsMinor} <= ${table.cogsMinor}`,
    ),
  ],
);

/**
 * Per-SKU profit, produced by the engine rather than recomputed downstream.
 *
 * Two implementations of an integer allocator diverge on the first rounding
 * remainder, after which order profit and the sum of its SKU profits stop
 * matching — the single most credibility-destroying bug this product can ship.
 */
export const orderProfitLines = pgTable(
  'order_profit_lines',
  {
    orderId: text('order_id')
      .notNull()
      .references(() => orderProfit.orderId, { onDelete: 'cascade' }),
    orderItemId: text('order_item_id').notNull(),
    storeId: text('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'cascade' }),
    businessDate: date('business_date', { mode: 'string' }).notNull(),
    // Denormalized so a per-product rollup does not have to join order_items.
    platformProductId: text('platform_product_id').notNull(),
    platformVariantId: text('platform_variant_id'),
    sku: text('sku'),
    quantity: integer('quantity').notNull(),

    allocatedOrderDiscountExVatMinor: money('allocated_order_discount_ex_vat_minor').notNull(),
    // ITEMS ONLY — what a merchant means by "revenue for this SKU". The
    // order-level revenue this line also earned is named separately rather than
    // folded in, so neither reading is lost.
    netRevenueExVatMinor: money('net_revenue_ex_vat_minor').notNull(),
    allocatedShippingRevenueExVatMinor: money('allocated_shipping_revenue_ex_vat_minor').notNull(),
    allocatedCodFeeRevenueExVatMinor: money('allocated_cod_fee_revenue_ex_vat_minor').notNull(),

    unitCostMinor: money('unit_cost_minor').notNull(),
    cogsMinor: money('cogs_minor').notNull(),
    costSource: text('cost_source').notNull(),
    costHistoryId: text('cost_history_id'),

    allocatedOutboundShippingMinor: money('allocated_outbound_shipping_minor').notNull(),
    allocatedReturnShippingMinor: money('allocated_return_shipping_minor').notNull(),
    allocatedGatewayFeeMinor: money('allocated_gateway_fee_minor').notNull(),
    allocatedCodCostMinor: money('allocated_cod_cost_minor').notNull(),

    reversedQuantity: integer('reversed_quantity').notNull(),
    reversedRevenueExVatMinor: money('reversed_revenue_ex_vat_minor').notNull(),
    restockedCogsMinor: money('restocked_cogs_minor').notNull(),
    reversalImpactMinor: money('reversal_impact_minor').notNull(),

    contributionMarginMinor: money('contribution_margin_minor').notNull(),
    costCoveredRevenueExVatMinor: money('cost_covered_revenue_ex_vat_minor').notNull(),
    calcVersion: integer('calc_version').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.orderId, table.orderItemId] }),
    // Profit per product over a date range — the second headline view.
    index('order_profit_lines_product_date_idx').on(
      table.storeId,
      table.platformProductId,
      table.platformVariantId,
      table.businessDate,
    ),
    index('order_profit_lines_store_date_idx').on(table.storeId, table.businessDate),
    check('order_profit_lines_cost_source_valid', oneOf(table.costSource, COST_SOURCES)),
    check('order_profit_lines_quantity_positive', nonNegative(table.quantity)),
    check(
      'order_profit_lines_restock_bounded',
      sql`${table.restockedCogsMinor} <= ${table.cogsMinor}`,
    ),
    // The line reconstructs its own margin, so a fixture reader — and a reviewer
    // reading a row — does not need to know the allocator.
    check(
      'order_profit_lines_margin_consistent',
      sql`${table.contributionMarginMinor} = ${table.netRevenueExVatMinor} + ${table.allocatedShippingRevenueExVatMinor} + ${table.allocatedCodFeeRevenueExVatMinor} - ${table.cogsMinor} - ${table.allocatedOutboundShippingMinor} - ${table.allocatedReturnShippingMinor} - ${table.allocatedGatewayFeeMinor} - ${table.allocatedCodCostMinor} + ${table.reversalImpactMinor}`,
    ),
  ],
);

// ───────────────────────────────────────────────────────────── rollups ─────

/**
 * Incremental, never a nightly full rebuild.
 *
 * Writing an `order_profit` row marks the affected `(store, business_date)`
 * bucket dirty; a worker rebuilds only what is dirty. The dashboard reads these
 * and never scans `order_profit` — which is what keeps a few hundred stores on
 * one Postgres instead of an analytics database.
 */
export const dailyStoreRollup = pgTable(
  'daily_store_rollup',
  {
    storeId: text('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'cascade' }),
    businessDate: date('business_date', { mode: 'string' }).notNull(),

    ordersCount: integer('orders_count').notNull().default(0),
    // Orders whose costs count but whose revenue does not — refused COD,
    // cancellations after dispatch. Kept out of the revenue denominator and out
    // of average order value, but never out of the margin.
    costOnlyCount: integer('cost_only_count').notNull().default(0),
    // Rows the dashboard must not rank as loss-makers: a margin computed with a
    // missing input is a bound, not a number.
    incompleteCount: integer('incomplete_count').notNull().default(0),

    revenueExVatMinor: money('revenue_ex_vat_minor').notNull().default('0'),
    cogsMinor: money('cogs_minor').notNull().default('0'),
    outboundShippingCostMinor: money('outbound_shipping_cost_minor').notNull().default('0'),
    returnShippingCostMinor: money('return_shipping_cost_minor').notNull().default('0'),
    gatewayFeeCostMinor: money('gateway_fee_cost_minor').notNull().default('0'),
    codCostMinor: money('cod_cost_minor').notNull().default('0'),
    reversalImpactMinor: money('reversal_impact_minor').notNull().default('0'),
    contributionMarginMinor: money('contribution_margin_minor').notNull().default('0'),
    // Numerator and denominator, so "cost data covers X% of revenue" is a
    // division of two sums rather than an average of percentages.
    costCoveredRevenueExVatMinor: money('cost_covered_revenue_ex_vat_minor').notNull().default('0'),

    // The whole point of the incremental design: a late-arriving carrier cost
    // sets this on the ORDER's bucket, not today's.
    dirty: boolean('dirty').notNull().default(true),
    dirtiedAt: instant('dirtied_at').defaultNow().notNull(),
    computedAt: instant('computed_at'),
    calcVersion: integer('calc_version'),
  },
  (table) => [
    primaryKey({ columns: [table.storeId, table.businessDate] }),
    // The sweep's only query: what needs rebuilding, oldest first.
    index('daily_store_rollup_dirty_idx').on(table.dirtiedAt).where(sql`${table.dirty}`),
  ],
);

export const dailyVariantRollup = pgTable(
  'daily_variant_rollup',
  {
    storeId: text('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'cascade' }),
    businessDate: date('business_date', { mode: 'string' }).notNull(),
    platformProductId: text('platform_product_id').notNull(),
    // Empty string, not NULL: a NULL in a primary key is not allowed, and a
    // product with no variants still needs a row.
    platformVariantId: text('platform_variant_id').notNull().default(''),
    sku: text('sku'),

    unitsSold: integer('units_sold').notNull().default(0),
    unitsReversed: integer('units_reversed').notNull().default(0),
    netRevenueExVatMinor: money('net_revenue_ex_vat_minor').notNull().default('0'),
    cogsMinor: money('cogs_minor').notNull().default('0'),
    allocatedShippingMinor: money('allocated_shipping_minor').notNull().default('0'),
    allocatedGatewayFeeMinor: money('allocated_gateway_fee_minor').notNull().default('0'),
    allocatedCodCostMinor: money('allocated_cod_cost_minor').notNull().default('0'),
    reversalImpactMinor: money('reversal_impact_minor').notNull().default('0'),
    contributionMarginMinor: money('contribution_margin_minor').notNull().default('0'),
    costCoveredRevenueExVatMinor: money('cost_covered_revenue_ex_vat_minor').notNull().default('0'),
    // Lines whose cost was missing. Loss-maker ranking must exclude a variant
    // with any of these: an uncosted SKU reports as the best product in the
    // catalogue, which is the exact failure this feature must not produce.
    incompleteLines: integer('incomplete_lines').notNull().default(0),

    dirty: boolean('dirty').notNull().default(true),
    dirtiedAt: instant('dirtied_at').defaultNow().notNull(),
    computedAt: instant('computed_at'),
    calcVersion: integer('calc_version'),
  },
  (table) => [
    primaryKey({
      columns: [table.storeId, table.businessDate, table.platformProductId, table.platformVariantId],
    }),
    index('daily_variant_rollup_dirty_idx').on(table.dirtiedAt).where(sql`${table.dirty}`),
    // Loss-maker ranking over a date range.
    index('daily_variant_rollup_margin_idx').on(
      table.storeId,
      table.businessDate,
      table.contributionMarginMinor,
    ),
  ],
);
