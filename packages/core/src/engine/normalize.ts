import { MAX_MINOR } from '@ghalla/contracts';
import type {
  CanonicalOrder,
  CanonicalOrderItem,
  CanonicalReversal,
  CanonicalShipment,
} from '@ghalla/contracts';
import type { Diagnostic } from '../diagnostics.js';
import type { OrderProfitInput } from '../input.js';
import type { ResolvedCost } from '../cost.js';
import { diagnostic, onOrder } from './diagnostics-builder.js';

/** Every cost, indexed the two ways a line can be resolved. */
export interface CostIndex {
  readonly byProductKey: ReadonlyMap<string, ResolvedCost>;
  readonly bySku: ReadonlyMap<string, ResolvedCost>;
}

export interface NormalizedInput {
  readonly order: CanonicalOrder;
  /**
   * Sorted by `platformLineId`. Deterministic ordering is a precondition for
   * every allocation invariant: re-ingesting the same order with its items in a
   * different order must produce identical per-SKU numbers.
   */
  readonly items: readonly CanonicalOrderItem[];
  readonly shipments: readonly CanonicalShipment[];
  readonly reversals: readonly CanonicalReversal[];
  readonly costs: CostIndex;
}

export function productKeyOf(platformProductId: string, platformVariantId: string | null): string {
  return `${platformProductId}|${platformVariantId ?? ''}`;
}

const validMinor = (value: number): boolean =>
  Number.isSafeInteger(value) && value <= MAX_MINOR && value >= -MAX_MINOR;

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The only path to `status: 'rejected'`.
 *
 * These are caller and ingestion defects, never merchant data gaps. A missing
 * cost is a warning the merchant can act on; an item belonging to a different
 * order is a bug that must be dead-lettered rather than retried, because
 * retrying produces the same wrong answer forever.
 */
export function normalizeAndValidate(input: Readonly<OrderProfitInput>): {
  readonly normalized: NormalizedInput | null;
  readonly diagnostics: readonly Diagnostic[];
} {
  const fatal: Diagnostic[] = [];
  const { order, store, feeRuleSet } = input;

  if (order.currency !== store.currency) fatal.push(onOrder('CURRENCY_MISMATCH'));
  if (feeRuleSet.currency !== store.currency) fatal.push(onOrder('CURRENCY_MISMATCH'));

  for (const money of [
    order.subtotalExVatMinor,
    order.vatAmountMinor,
    order.shippingChargedExVatMinor,
    order.codFeeChargedExVatMinor,
    order.totalIncVatMinor,
  ]) {
    if (!validMinor(money)) fatal.push(onOrder('NON_INTEGER_MINOR_UNITS'));
  }

  for (const item of input.items) {
    if (item.orderId !== order.id) {
      fatal.push(diagnostic('ITEM_ORDER_ID_MISMATCH', { kind: 'line', orderItemId: item.id }));
    }
    if (!Number.isSafeInteger(item.quantity) || item.quantity < 0) {
      fatal.push(diagnostic('NEGATIVE_QUANTITY', { kind: 'line', orderItemId: item.id }));
    }
    for (const money of [
      item.unitPriceExVatMinor,
      item.grossLineExVatMinor,
      item.lineDiscountExVatMinor,
      item.lineTotalExVatMinor,
    ]) {
      if (!validMinor(money)) {
        fatal.push(diagnostic('NON_INTEGER_MINOR_UNITS', { kind: 'line', orderItemId: item.id }));
      }
    }
  }

  for (const reversal of input.reversals) {
    if (reversal.orderId !== order.id) {
      fatal.push(diagnostic('REVERSAL_ORDER_ID_MISMATCH', { kind: 'reversal', reversalId: reversal.id }));
    }
  }

  for (const shipment of input.shipments) {
    if (shipment.carrierCostMinor !== null && !validMinor(shipment.carrierCostMinor)) {
      fatal.push(diagnostic('NON_INTEGER_MINOR_UNITS', { kind: 'shipment', shipmentId: shipment.id }));
    }
  }

  // Two cost rows for one key means the as-of query returned overlapping
  // validity windows: a persistence bug. Silently taking the last row would
  // make a merchant's profit depend on the order the database returned.
  const byProductKey = new Map<string, ResolvedCost>();
  const bySku = new Map<string, ResolvedCost>();
  for (const cost of input.costs) {
    if (!validMinor(cost.unitCostMinor)) fatal.push(onOrder('NON_INTEGER_MINOR_UNITS'));
    const key = productKeyOf(cost.platformProductId, cost.platformVariantId);
    if (byProductKey.has(key)) fatal.push(onOrder('DUPLICATE_COST_KEY'));
    byProductKey.set(key, cost);
    if (cost.sku !== null && cost.sku !== '') {
      if (bySku.has(cost.sku)) fatal.push(onOrder('DUPLICATE_COST_KEY'));
      bySku.set(cost.sku, cost);
    }
  }

  if (fatal.length > 0) return { normalized: null, diagnostics: fatal };

  return {
    normalized: {
      order,
      items: [...input.items].sort((a, b) => byText(a.platformLineId, b.platformLineId)),
      shipments: [...input.shipments].sort((a, b) => byText(a.id, b.id)),
      reversals: [...input.reversals].sort((a, b) => byText(a.id, b.id)),
      costs: { byProductKey, bySku },
    },
    diagnostics: [],
  };
}
