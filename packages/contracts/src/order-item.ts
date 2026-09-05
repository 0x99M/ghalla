import type { Minor } from './money.js';
import type { OrderId, OrderItemId } from './ids.js';

export interface CanonicalOrderItem {
  readonly id: OrderItemId;
  readonly orderId: OrderId;
  /**
   * The platform's line identifier where one exists; otherwise a stable derived
   * key (sku + variant + occurrence, after sorting). NEVER the array index of a
   * fetch response.
   *
   * This is the precondition for every allocation invariant in the engine.
   * Without stable line identity, re-ingesting the same order with its items in
   * a different order produces a different discount and shipping allocation,
   * per-SKU margins churn between recomputes, and a reversal line has nothing to
   * join to. Product, variant and SKU together do not distinguish two lines of
   * the same variant — a bundle, or a gift-wrapped duplicate.
   */
  readonly platformLineId: string;
  readonly platformProductId: string;
  /** Nullable by necessity: some platforms expose no variant identity on order lines, only the SKU. */
  readonly platformVariantId: string | null;
  readonly sku: string | null;
  /** NOT `name` — that key is on the PII deny-list, and this is the one legitimate name in the model. */
  readonly productName: string;
  readonly quantity: number;
  readonly unitPriceExVatMinor: Minor;
  readonly grossLineExVatMinor: Minor;
  readonly lineDiscountExVatMinor: Minor;
  /**
   * AUTHORITATIVE line revenue: gross minus the line-level discount.
   * Order-level discounts are NOT included here — the engine allocates those.
   * The engine must never recompute this as `unitPrice × quantity`.
   */
  readonly lineTotalExVatMinor: Minor;
}
