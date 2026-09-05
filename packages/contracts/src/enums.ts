/**
 * Const tuple + derived union, never `enum`.
 *
 * `enum` is a compile error under `erasableSyntaxOnly`, and the runtime member
 * list is needed twice over — by each adapter's normalization lookup table, and
 * by `z.enum()` in `@ghalla/schemas`. One source of truth serves both.
 */

// --------------------------------------------------------------- orders ----

/**
 * Three orthogonal status axes replace the single `status` a naive model uses.
 *
 * They have to be orthogonal. "Shipped" and "refunded" are not mutually
 * exclusive; "cancelled" says nothing about whether money was captured. Most
 * decisively: a cash-on-delivery parcel refused at the door moves no money and
 * produces no refund record, so a model with one status axis reports the single
 * most common Saudi loss case — two shipping legs and no revenue — as a fully
 * profitable order.
 */
export const ORDER_LIFECYCLES = ['draft', 'open', 'completed', 'cancelled'] as const;
export type OrderLifecycle = (typeof ORDER_LIFECYCLES)[number];

export const PAYMENT_STATES = [
  'unpaid',
  'authorized',
  'paid',
  'partially_refunded',
  'refunded',
  'voided',
  'failed',
] as const;
export type PaymentState = (typeof PAYMENT_STATES)[number];

export const FULFILLMENT_STATES = [
  'unfulfilled',
  'partially_fulfilled',
  'in_transit',
  'delivered',
  'returned',
  /** Return to origin: the parcel came back. On an unpaid COD order this is pure loss. */
  'rto',
  'not_applicable',
] as const;
export type FulfillmentState = (typeof FULFILLMENT_STATES)[number];

/** Gates the shipping-cost fallback, which would otherwise invent a courier charge for a pickup order. */
export const FULFILLMENT_METHODS = ['carrier', 'pickup', 'self_delivery', 'digital', 'other'] as const;
export type FulfillmentMethod = (typeof FULFILLMENT_METHODS)[number];

// ------------------------------------------------------------- payments ----

/**
 * The rail. Deliberately separate from the card network and from the wallet
 * that presented it: a scheme and a presentment wrapper are not peers of a rail,
 * and flattening them makes the fee unpriceable.
 */
export const PAYMENT_INSTRUMENTS = [
  'card',
  'bnpl',
  'wallet',
  'cod',
  'bank_transfer',
  /** A fully discounted order. Distinct from unpaid: nothing is owed. */
  'free',
  'unknown',
  'other',
] as const;
export type PaymentInstrument = (typeof PAYMENT_INSTRUMENTS)[number];

/**
 * The card network. Closed, because it is a fee-rule key over a genuinely
 * finite set — and `mada`, the Saudi domestic debit network, prices completely
 * differently from an international credit card.
 *
 * `unknown` is a first-class member so an adapter never has to guess. A platform
 * that reports a wallet without the scheme behind it must be able to say so and
 * let the engine downgrade confidence, rather than silently picking a rate.
 */
export const CARD_SCHEMES = ['mada', 'visa', 'mastercard', 'amex', 'unionpay', 'other', 'unknown'] as const;
export type CardScheme = (typeof CARD_SCHEMES)[number];

/** An uncaptured leg must never accrue a gateway fee. */
export const PAYMENT_LEG_STATES = ['pending', 'authorized', 'captured', 'failed', 'refunded'] as const;
export type PaymentLegState = (typeof PAYMENT_LEG_STATES)[number];

// ------------------------------------------------------------ shipments ----

export const SHIPMENT_DIRECTIONS = ['outbound', 'return'] as const;
export type ShipmentDirection = (typeof SHIPMENT_DIRECTIONS)[number];

export const SHIPMENT_STATUSES = [
  'created',
  'in_transit',
  'out_for_delivery',
  'delivered',
  'failed_attempt',
  'returned_to_origin',
  'cancelled',
  'lost',
  'unknown',
] as const;
export type ShipmentStatus = (typeof SHIPMENT_STATUSES)[number];

// ------------------------------------------------------------ reversals ----

/**
 * A void never settled, so its gateway fee was never incurred and must not be
 * treated as sunk. A chargeback is strictly worse than a refund. Collapsing the
 * three loses money in both directions.
 */
export const REVERSAL_KINDS = ['refund', 'void', 'chargeback'] as const;
export type ReversalKind = (typeof REVERSAL_KINDS)[number];

export const REVERSAL_REASONS = [
  'customer_return',
  'damaged_or_defective',
  'wrong_item',
  'cancelled_before_dispatch',
  'goodwill_or_price_adjustment',
  'chargeback',
  'other',
  'unknown',
] as const;
export type ReversalReason = (typeof REVERSAL_REASONS)[number];

/**
 * Not a boolean. One line of a multi-line return comes back sellable while
 * another is damaged, and at the moment a refund is issued the goods are
 * usually still in transit — so a boolean defaults to `false` and permanently
 * understates the merchant's margin.
 */
export const RESTOCK_OUTCOMES = [
  'restocked_sellable',
  'restocked_damaged',
  'not_restocked',
  'pending_receipt',
  'not_applicable',
  'unknown',
] as const;
export type RestockOutcome = (typeof RESTOCK_OUTCOMES)[number];

// ----------------------------------------------------------------- cost ----

export const COST_SOURCES = [
  'merchant_manual',
  'merchant_bulk_import',
  'platform',
  'category_default',
  'none',
] as const;
export type CostSource = (typeof COST_SOURCES)[number];

/** Which sources count toward the "cost data covers X% of revenue" indicator. */
export const EXACT_COST_SOURCES: readonly CostSource[] = [
  'merchant_manual',
  'merchant_bulk_import',
  'platform',
];

// ---------------------------------------------------------- attribution ----

export const DEVICES = ['desktop', 'mobile', 'tablet', 'unknown'] as const;
export type Device = (typeof DEVICES)[number];

// ------------------------------------------------------------ open sets ----

/**
 * Open slugs, NOT closed unions. Normalized by the adapter to
 * `/^[a-z0-9][a-z0-9_-]*$/`, with the platform's verbatim label kept alongside.
 *
 * Closing these would force a release of the package everything depends on —
 * plus a database enum migration — every time a courier or a payment processor
 * appears in the market. The raw-label-plus-log-unknowns pattern already covers
 * triage.
 */
export type CarrierSlug = string;
export type ProviderSlug = string;
export type WalletSlug = string;
