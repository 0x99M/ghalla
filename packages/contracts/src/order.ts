import type { Device, FulfillmentMethod, FulfillmentState, OrderLifecycle, PaymentState } from './enums.js';
import type { Bps, CurrencyCode, Minor } from './money.js';
import type { CustomerRef, OrderId, StoreId } from './ids.js';
import type { Instant } from './time.js';
import type { PaymentBreakdown } from './payment.js';

/**
 * Where the parcel is going, minus everything that identifies who lives there.
 *
 * City and region are retained deliberately: they are the *only* input to the
 * shipping-cost fallback rule, and with actual carrier cost unavailable from the
 * platforms, that fallback is the primary path for the largest cost line in the
 * model — not an edge case.
 */
export interface OrderDestination {
  /** ISO-3166 alpha-2. */
  readonly countryCode: string;
  readonly region: string | null;
  readonly city: string | null;
}

/**
 * A discount, with the one field that makes double-counting unrepresentable.
 *
 * Without `reflectedInComponent`, an order-level coupon either inflates revenue
 * by its full value or — once someone "fixes" that — deflates it by the same
 * amount on platforms that already prorated it into the line totals. Nothing in
 * the types would say which, and both errors look plausible in review.
 */
export interface OrderDiscount {
  readonly code: string | null;
  readonly target: 'items' | 'shipping' | 'cod_fee';
  /**
   * `true`  — already deducted from the target's canonical amount. The engine
   *           ignores it and keeps it for audit only.
   * `false` — not yet deducted. The engine subtracts it from the target and,
   *           for `items`, allocates it across lines by revenue share.
   */
  readonly reflectedInComponent: boolean;
  readonly amountExVatMinor: Minor;
}

/**
 * How the order was acquired. Deliberately small.
 *
 * UTM fields are absent because the platforms do not carry them, ad-spend
 * attribution is out of scope, and five permanently-null columns read to a
 * merchant — and to us, six months later — as an ingestion bug rather than an
 * unbuilt feature. Adding them when ad spend enters scope is purely additive.
 *
 * The referrer is truncated to its host by the adapter: query strings carry
 * search terms and identifiers.
 */
export interface Attribution {
  readonly device: Device;
  readonly referrerHost: string | null;
}

export interface CanonicalOrder {
  /** Derived from the platform's own identity, never minted. See `toOrderId`. */
  readonly id: OrderId;
  readonly storeId: StoreId;
  readonly platformOrderId: string;
  readonly placedAt: Instant;
  readonly platformUpdatedAt: Instant | null;

  // --- three orthogonal status axes, plus the platform's own label ---
  readonly lifecycle: OrderLifecycle;
  readonly paymentState: PaymentState;
  readonly fulfillmentState: FulfillmentState;
  /** Merchants define custom statuses, so the normalized axes alone cannot round-trip. */
  readonly platformStatusId: string | null;
  readonly rawStatusLabel: string;
  readonly isTest: boolean;

  readonly fulfillmentMethod: FulfillmentMethod;
  readonly destination: OrderDestination | null;

  readonly currency: CurrencyCode;
  /** The VAT rate that applied to THIS order, snapshotted at ingestion. */
  readonly vatRateBps: Bps;

  /**
   * Sum of the line totals: net of line-level discounts, GROSS of any
   * `OrderDiscount` whose `reflectedInComponent` is `false`.
   */
  readonly subtotalExVatMinor: Minor;
  /**
   * TOTAL output VAT on the order — goods *and* shipping *and* COD fee, after
   * discounts. Not goods-only: read that way, shipping VAT is unaccounted for
   * and no order ever reconciles.
   */
  readonly vatAmountMinor: Minor;
  /** Named for its VAT basis, because the platform's own field usually is not. */
  readonly shippingChargedExVatMinor: Minor;
  readonly codFeeChargedExVatMinor: Minor;
  readonly totalIncVatMinor: Minor;

  readonly discounts: readonly OrderDiscount[];
  readonly payments: readonly PaymentBreakdown[];

  readonly customerRef: CustomerRef | null;
  readonly attribution: Attribution | null;
}

/**
 * The reconciliation identity the engine asserts on every order:
 *
 * ```
 * totalIncVatMinor === subtotalExVatMinor
 *                    - Σ(discounts where !reflectedInComponent)
 *                    + shippingChargedExVatMinor
 *                    + codFeeChargedExVatMinor
 *                    + vatAmountMinor
 * ```
 *
 * Failure is a warning, never a throw: a mis-reconciling order still yields a
 * usable, flagged number, and the count of that diagnostic across a store is the
 * metric that tells us an adapter's mapping is wrong.
 */
export const ORDER_RECONCILIATION_IDENTITY =
  'total = subtotal - unreflectedDiscounts + shipping + codFee + vat' as const;
