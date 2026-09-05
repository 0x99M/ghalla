import type { RestockOutcome, ReversalKind, ReversalReason } from './enums.js';
import type { Minor } from './money.js';
import type { OrderId, OrderItemId, ReversalId } from './ids.js';
import type { Instant } from './time.js';

export interface CanonicalReversalLine {
  readonly orderItemId: OrderItemId;
  readonly quantity: number;
  readonly amountExVatMinor: Minor;
  readonly restockOutcome: RestockOutcome;
}

/**
 * Money flowing back to the customer. Named a reversal, not a refund, because it
 * also covers voids and chargebacks, whose arithmetic differs.
 *
 * A return to origin is NOT modelled here. On a refused cash-on-delivery parcel
 * no money ever moved, so a zero-amount reversal row would be a phantom record
 * that either double-counts or mis-signs. An RTO is expressed on the order —
 * `paymentState: 'unpaid'` with `fulfillmentState: 'rto'` — and its return leg
 * is a shipment with `direction: 'return'`.
 */
export interface CanonicalReversal {
  /**
   * Derived. On platforms with no refund entity — where a refund is discovered
   * by diffing order state — the derivation must be stable, or every webhook
   * redelivery subtracts the same money again.
   */
  readonly id: ReversalId;
  readonly orderId: OrderId;
  readonly platformReversalId: string | null;
  readonly kind: ReversalKind;
  readonly reason: ReversalReason;
  readonly rawReasonLabel: string | null;
  readonly occurredAt: Instant;

  /** Item revenue reversed, excluding VAT. A single gross scalar here is a 15% error on every refund. */
  readonly amountExVatMinor: Minor;
  readonly shippingRefundExVatMinor: Minor;
  readonly codFeeRefundExVatMinor: Minor;
  /**
   * Value attributable to no line, no shipping and no COD fee — a goodwill
   * gesture or a price adjustment. Without a slot for it the totals identity
   * cannot close, and adapters smear goodwill across SKUs that did nothing wrong.
   */
  readonly adjustmentExVatMinor: Minor;
  readonly vatMinor: Minor;
  readonly totalIncVatMinor: Minor;

  /**
   * `null` when the platform reported no line detail; the engine then allocates
   * by revenue share and flags the result as allocated rather than reported.
   *
   * Line detail is what makes per-SKU margin survive a partial return. Without
   * it, returning the cheap item and returning the expensive one produce
   * identical records — and the difference is not recoverable later.
   */
  readonly lines: readonly CanonicalReversalLine[] | null;
  /** Reversal-level fallback, read only when `lines` is `null`. */
  readonly restockOutcome: RestockOutcome;
  readonly platformUpdatedAt: Instant | null;
}

/**
 * ```
 * totalIncVatMinor === amountExVatMinor + shippingRefundExVatMinor
 *                     + codFeeRefundExVatMinor + adjustmentExVatMinor + vatMinor
 * lines !== null  ⇒  Σ(lines.amountExVatMinor) === amountExVatMinor
 * ```
 */
export const REVERSAL_RECONCILIATION_IDENTITY =
  'total = items + shippingRefund + codFeeRefund + adjustment + vat' as const;
