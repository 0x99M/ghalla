import type { CanonicalOrder, CanonicalShipment } from '@ghalla/contracts';
import type { ProfitRecognition } from '../result.js';

/** Anything that has left the warehouse. Exported so shipping.ts does not duplicate the set. */
export const DISPATCHED = new Set(['partially_fulfilled', 'in_transit', 'delivered', 'returned', 'rto']);

/** Payment states where nothing the merchant can keep ever settled. */
const NEVER_SETTLED = new Set(['unpaid', 'authorized', 'failed', 'voided']);

/** A shipment leg that is still economically live. */
const LIVE = new Set([
  'created',
  'in_transit',
  'out_for_delivery',
  'delivered',
  'failed_attempt',
  'returned_to_origin',
  'lost',
  'unknown',
]);

/**
 * Whether this order's money counts, and how.
 *
 * The case a single status axis cannot express: a cash-on-delivery parcel
 * refused at the door. No money ever moved, so no refund record exists
 * anywhere — and an order whose revenue is derived from line totals and
 * reversed only through refunds reports it as fully profitable, when the truth
 * is two shipping legs of pure loss. It is the dominant loss shape in this
 * market, so this is not an edge case.
 *
 * `authorized` belongs in that set alongside `unpaid`: money reserved and never
 * captured is money the merchant never had, and on a refused parcel never will.
 */
export function computeRecognition(
  order: CanonicalOrder,
  shipments: readonly CanonicalShipment[],
): ProfitRecognition {
  if (order.isTest) return { kind: 'excluded', reason: 'test_order' };
  if (order.lifecycle === 'draft') return { kind: 'excluded', reason: 'draft' };

  // Goods went out, nothing was collected, the parcel came back.
  if (order.fulfillmentState === 'rto' && NEVER_SETTLED.has(order.paymentState)) {
    return { kind: 'cost_only', reason: 'rto_uncollected' };
  }

  // The courier lost the parcel. Terminal: the goods are gone and the cash will
  // never arrive, so booking the sale would report a completed profitable order
  // for a shipment that no longer exists.
  const live = shipments.filter((s) => s.direction === 'outbound' && LIVE.has(s.status));
  if (live.length > 0 && live.every((s) => s.status === 'lost') && NEVER_SETTLED.has(order.paymentState)) {
    return { kind: 'cost_only', reason: 'goods_lost' };
  }

  // A payment that was voided or declined leaves nothing behind, whatever the
  // lifecycle says — and platforms routinely leave an order `open` after one.
  if (order.paymentState === 'voided' || order.paymentState === 'failed') {
    return DISPATCHED.has(order.fulfillmentState)
      ? { kind: 'cost_only', reason: 'payment_not_settled' }
      : { kind: 'excluded', reason: 'cancelled_before_economic_effect' };
  }

  if (order.lifecycle === 'cancelled') {
    // Partially refunded is the inverted case: money moved and only part of it
    // came back, so revenue must count and the reversal records remove the rest.
    // Zeroing it would swing a SAR 600 order by SAR 565 on one status field.
    if (order.paymentState === 'partially_refunded') return { kind: 'recognized' };
    if (order.paymentState === 'paid' || order.paymentState === 'refunded') {
      return { kind: 'cost_only', reason: 'cancelled_after_capture' };
    }
    if (DISPATCHED.has(order.fulfillmentState)) {
      return { kind: 'cost_only', reason: 'cancelled_after_dispatch' };
    }
    return { kind: 'excluded', reason: 'cancelled_before_economic_effect' };
  }

  return { kind: 'recognized' };
}

/** True when the order's costs count but its revenue does not. */
export function isCostOnly(recognition: ProfitRecognition): boolean {
  return recognition.kind === 'cost_only';
}

/** True when nothing about the order counts, not even its costs. */
export function isExcluded(recognition: ProfitRecognition): boolean {
  return recognition.kind === 'excluded';
}
