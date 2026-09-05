import { toMinor } from '@ghalla/contracts';
import type { CanonicalOrder, CanonicalOrderItem, Minor, OrderItemId } from '@ghalla/contracts';
import type { Diagnostic } from '../diagnostics.js';
import type { ProfitRecognition } from '../result.js';
import { addMinor, allocateMinor, subMinor } from '../money.js';
import { onOrder } from './diagnostics-builder.js';
import type { Computed } from './diagnostics-builder.js';

const ZERO = toMinor(0);

export interface LineRevenue {
  readonly orderItemId: OrderItemId;
  /** Line total as the platform reported it, net of the platform's own line discount. */
  readonly grossExVatMinor: Minor;
  /** This line's share of order-level discounts that target ITEMS. */
  readonly allocatedOrderDiscountExVatMinor: Minor;
  readonly netExVatMinor: Minor;
}

export interface OrderRevenue {
  readonly lines: readonly LineRevenue[];
  readonly itemsRevenueExVatMinor: Minor;
  readonly shippingRevenueExVatMinor: Minor;
  readonly codFeeRevenueExVatMinor: Minor;
  /** Every unreflected order-level discount, whatever it targets. */
  readonly orderDiscountExVatMinor: Minor;
  readonly revenueExVatMinor: Minor;
  readonly vatCollectedMinor: Minor;
  readonly reconciles: boolean;
}

function unreflected(order: CanonicalOrder, target: 'items' | 'shipping' | 'cod_fee'): Minor {
  return addMinor(
    ...order.discounts
      .filter((d) => d.target === target && !d.reflectedInComponent)
      .map((d) => d.amountExVatMinor),
  );
}

/**
 * Allocates order-level item discounts across lines.
 *
 * A coupon the platform has not already prorated has to land somewhere, or the
 * order's revenue and the sum of its SKUs' revenue disagree. Weighting by line
 * revenue is the only defensible split without knowing the coupon's own rules.
 */
export function computeLineRevenue(
  items: readonly CanonicalOrderItem[],
  itemDiscountMinor: Minor,
): readonly LineRevenue[] {
  if (items.length === 0) return [];
  const allocation = allocateMinor(
    itemDiscountMinor,
    items.map((item) => ({ key: item.id, weight: item.lineTotalExVatMinor })),
  );
  return items.map((item) => {
    const share = allocation.get(item.id) ?? ZERO;
    return {
      orderItemId: item.id,
      grossExVatMinor: item.lineTotalExVatMinor,
      allocatedOrderDiscountExVatMinor: share,
      netExVatMinor: subMinor(item.lineTotalExVatMinor, share),
    };
  });
}

/**
 * Revenue, excluding VAT entirely — it is the government's money passing
 * through the merchant's account, not theirs.
 *
 * For a `cost_only` order every revenue term is zero: the costs were real and
 * nothing was collected. That is what stops a refused cash-on-delivery parcel
 * from reporting as a profitable sale.
 */
export function computeRevenue(
  order: CanonicalOrder,
  items: readonly CanonicalOrderItem[],
  recognition: ProfitRecognition,
): Computed<OrderRevenue> {
  const diagnostics: Diagnostic[] = [];

  const itemsGross = addMinor(...items.map((i) => i.lineTotalExVatMinor));
  const itemDiscount = unreflected(order, 'items');
  const shippingDiscount = unreflected(order, 'shipping');
  const codDiscount = unreflected(order, 'cod_fee');
  const orderDiscount = addMinor(itemDiscount, shippingDiscount, codDiscount);

  // The reconciliation identity is checked against what the ADAPTER reported,
  // regardless of recognition: it is a statement about the mapping, and the
  // count of failures across a store is the metric that says a mapping is wrong.
  const expectedTotal = addMinor(
    order.subtotalExVatMinor,
    toMinor(-orderDiscount),
    order.shippingChargedExVatMinor,
    order.codFeeChargedExVatMinor,
    order.vatAmountMinor,
  );
  const subtotalMatches = order.subtotalExVatMinor === itemsGross || items.length === 0;
  const reconciles = expectedTotal === order.totalIncVatMinor && subtotalMatches;
  if (!reconciles) diagnostics.push(onOrder('TOTALS_DO_NOT_RECONCILE'));
  if (items.length === 0) diagnostics.push(onOrder('ORDER_HAS_NO_ITEMS'));

  if (recognition.kind !== 'recognized') {
    diagnostics.push(onOrder(recognition.kind === 'cost_only' ? 'RECOGNITION_COST_ONLY' : 'ORDER_EXCLUDED'));
    return {
      value: {
        lines: items.map((item) => ({
          orderItemId: item.id,
          grossExVatMinor: ZERO,
          allocatedOrderDiscountExVatMinor: ZERO,
          netExVatMinor: ZERO,
        })),
        itemsRevenueExVatMinor: ZERO,
        shippingRevenueExVatMinor: ZERO,
        codFeeRevenueExVatMinor: ZERO,
        orderDiscountExVatMinor: ZERO,
        revenueExVatMinor: ZERO,
        vatCollectedMinor: ZERO,
        reconciles,
      },
      diagnostics,
    };
  }

  const revenue = addMinor(
    itemsGross,
    order.shippingChargedExVatMinor,
    order.codFeeChargedExVatMinor,
    toMinor(-orderDiscount),
  );

  return {
    value: {
      lines: computeLineRevenue(items, itemDiscount),
      itemsRevenueExVatMinor: itemsGross,
      shippingRevenueExVatMinor: order.shippingChargedExVatMinor,
      codFeeRevenueExVatMinor: order.codFeeChargedExVatMinor,
      orderDiscountExVatMinor: orderDiscount,
      revenueExVatMinor: revenue,
      vatCollectedMinor: order.vatAmountMinor,
      reconciles,
    },
    diagnostics,
  };
}

/** The shipping and COD-fee discounts, so the allocator can net them off the right term. */
export function targetedDiscounts(order: CanonicalOrder): {
  readonly shipping: Minor;
  readonly codFee: Minor;
} {
  return { shipping: unreflected(order, 'shipping'), codFee: unreflected(order, 'cod_fee') };
}
