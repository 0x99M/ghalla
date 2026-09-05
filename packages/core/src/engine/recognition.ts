import type { CanonicalOrder } from '@ghalla/contracts';
import type { ProfitRecognition } from '../result.js';

const DISPATCHED = new Set(['partially_fulfilled', 'in_transit', 'delivered', 'returned', 'rto']);
const MONEY_MOVED = new Set(['paid', 'partially_refunded', 'refunded']);

/**
 * Whether this order's money counts, and how.
 *
 * The case a single status axis cannot express: a cash-on-delivery parcel
 * refused at the door. No money ever moved, so no refund record exists
 * anywhere — and an order whose revenue is derived from line totals and
 * reversed only through refunds reports it as fully profitable, when the truth
 * is two shipping legs of pure loss. It is the dominant loss shape in this
 * market, so this is not an edge case.
 */
export function computeRecognition(order: CanonicalOrder): ProfitRecognition {
  if (order.isTest) return { kind: 'excluded', reason: 'test_order' };
  if (order.lifecycle === 'draft') return { kind: 'excluded', reason: 'draft' };

  // Goods went out, nothing was collected, the parcel came back.
  if (
    order.fulfillmentState === 'rto' &&
    (order.paymentState === 'unpaid' || order.paymentState === 'failed' || order.paymentState === 'voided')
  ) {
    return { kind: 'cost_only', reason: 'rto_uncollected' };
  }

  if (order.lifecycle === 'cancelled') {
    if (MONEY_MOVED.has(order.paymentState)) {
      return { kind: 'cost_only', reason: 'cancelled_after_capture' };
    }
    if (DISPATCHED.has(order.fulfillmentState)) {
      return { kind: 'cost_only', reason: 'cancelled_after_dispatch' };
    }
    return { kind: 'excluded', reason: 'cancelled_before_economic_effect' };
  }

  return { kind: 'recognized' };
}
