import type {
  Bps,
  CalcVersion,
  CostHistoryId,
  CostSource,
  CurrencyCode,
  FeeRuleSetId,
  LocalDate,
  Minor,
  OrderId,
  OrderItemId,
  StoreId,
} from '@ghalla/contracts';
import type { Diagnostic } from './diagnostics.js';
import type { ProfitConfidence } from './confidence.js';

/**
 * Whether this order's money counts, and how.
 *
 * `cost_only` is the case a simpler model cannot express: an order whose costs
 * are real and whose revenue is zero. A refused cash-on-delivery parcel is the
 * common one — two shipping legs paid, nothing collected, and no refund record
 * anywhere because no money ever moved. It must contribute negative margin
 * without polluting revenue or average-order-value denominators.
 */
export type ProfitRecognition =
  | { readonly kind: 'recognized' }
  | {
      readonly kind: 'cost_only';
      readonly reason:
        | 'rto_uncollected'
        | 'cancelled_after_dispatch'
        | 'cancelled_after_capture'
        /** Voided or declined outside a cancellation: platforms leave these `open`. */
        | 'payment_not_settled'
        /** Every live outbound leg is lost. Terminal — the cash will never arrive. */
        | 'goods_lost';
    }
  | {
      readonly kind: 'excluded';
      readonly reason: 'test_order' | 'draft' | 'cancelled_before_economic_effect';
    };

/**
 * Every cost term is a POSITIVE magnitude. Only `reversalImpactMinor` and
 * `contributionMarginMinor` are signed. Mixing the two conventions in one
 * structure is how a sign error survives review.
 */
export interface OrderProfitTotals {
  readonly itemsRevenueExVatMinor: Minor;
  readonly shippingRevenueExVatMinor: Minor;
  readonly codFeeRevenueExVatMinor: Minor;
  readonly orderDiscountExVatMinor: Minor;
  readonly revenueExVatMinor: Minor;
  /** Reported for reconciliation against the merchant's own dashboard. NEVER deducted: VAT is pass-through. */
  readonly vatCollectedMinor: Minor;

  readonly cogsMinor: Minor;
  /**
   * Outbound and return legs are separate terms rather than one shipping line,
   * because a return-to-origin has no reversal to hang its cost on — and folding
   * return shipping into the refund impact makes the single largest Saudi loss
   * case structurally invisible.
   */
  readonly outboundShippingCostMinor: Minor;
  readonly returnShippingCostMinor: Minor;

  readonly gatewayFeeExVatMinor: Minor;
  readonly gatewayFeeVatMinor: Minor;
  /** `ex + (vatRegistered ? 0 : vat)` — what the merchant actually loses. */
  readonly gatewayFeeCostMinor: Minor;
  readonly codCostExVatMinor: Minor;
  readonly codCostVatMinor: Minor;
  readonly codCostMinor: Minor;

  readonly reversedRevenueExVatMinor: Minor;
  readonly restockedCogsMinor: Minor;
  /** Signed; normally ≤ 0. Outbound shipping and gateway fees stay sunk — a refunded order still paid to ship. */
  readonly reversalImpactMinor: Minor;

  readonly contributionMarginMinor: Minor;
  /** `null` iff revenue is zero or negative, because a ratio to zero is not a small number, it is nothing. */
  readonly marginBps: Bps | null;
  /**
   * The "cost data covers X% of revenue" indicator, stored as a NUMERATOR.
   *
   * Ratios do not aggregate. An average of per-order percentages is not the
   * store's percentage unless every rollup remembers to weight it by revenue,
   * and the one that forgets is subtly, unfalsifiably wrong.
   *
   * THE DENOMINATOR IS `Σ(lines.netRevenueExVatMinor)`, not `revenueExVatMinor`.
   * The latter includes shipping and COD-fee revenue, which no cost can ever
   * cover — dividing by it caps every store below 100% and sends a merchant
   * with fully costed items hunting for costs that are not missing.
   */
  readonly costCoveredRevenueExVatMinor: Minor;
}

/**
 * Per-SKU profit, produced by the engine rather than recomputed downstream.
 *
 * Profit per product and loss-maker flagging are headline deliverables, and
 * attributing order-level costs to lines outside the engine would duplicate the
 * discount and shipping allocation. Two implementations of an integer allocator
 * diverge on the first rounding remainder, after which order profit and the sum
 * of its SKU profits stop matching — the single most credibility-destroying bug
 * this product can ship.
 */
/**
 * A line carries every term of its own margin, so a reader of a fixture can
 * reconstruct it without knowing the allocator:
 *
 * ```
 * contributionMarginMinor
 *   =  netRevenueExVatMinor                 // items only, after its share of item discounts
 *   +  allocatedShippingRevenueExVatMinor   // what the customer paid to ship, allocated
 *   +  allocatedCodFeeRevenueExVatMinor
 *   -  cogsMinor
 *   -  allocatedOutboundShippingMinor
 *   -  allocatedReturnShippingMinor
 *   -  allocatedGatewayFeeMinor
 *   -  allocatedCodCostMinor
 *   +  reversalImpactMinor
 * ```
 *
 * `netRevenueExVatMinor` stays ITEMS ONLY because that is what a merchant means
 * by "revenue for this SKU". The order-level revenue a line also earned is
 * named separately rather than folded in, so neither reading is lost.
 */
export interface OrderProfitLine {
  readonly orderItemId: OrderItemId;
  readonly platformProductId: string;
  readonly platformVariantId: string | null;
  readonly sku: string | null;
  readonly quantity: number;

  /** This line's share of order-level discounts targeting ITEMS. Already deducted from netRevenue. */
  readonly allocatedOrderDiscountExVatMinor: Minor;
  readonly netRevenueExVatMinor: Minor;
  /** Order-level revenue allocated to this line, net of discounts targeting it. */
  readonly allocatedShippingRevenueExVatMinor: Minor;
  readonly allocatedCodFeeRevenueExVatMinor: Minor;

  readonly unitCostMinor: Minor;
  readonly cogsMinor: Minor;
  readonly costSource: CostSource;
  readonly costHistoryId: CostHistoryId | null;

  readonly allocatedOutboundShippingMinor: Minor;
  readonly allocatedReturnShippingMinor: Minor;
  readonly allocatedGatewayFeeMinor: Minor;
  readonly allocatedCodCostMinor: Minor;

  readonly reversedQuantity: number;
  readonly reversedRevenueExVatMinor: Minor;
  readonly restockedCogsMinor: Minor;
  readonly reversalImpactMinor: Minor;

  readonly contributionMarginMinor: Minor;
  readonly costCoveredRevenueExVatMinor: Minor;
}

export interface OrderProfitComputed {
  readonly status: 'computed';
  readonly orderId: OrderId;
  readonly storeId: StoreId;
  readonly currency: CurrencyCode;
  /**
   * Store-local, denormalized here so a fact arriving days late invalidates the
   * ORDER's bucket rather than today's.
   */
  readonly businessDate: LocalDate;
  readonly calcVersion: CalcVersion;
  /** Which rule set produced the fee numbers, so republishing rates is a targeted recompute. */
  readonly feeRuleSetId: FeeRuleSetId;
  readonly recognition: ProfitRecognition;
  readonly totals: OrderProfitTotals;
  readonly lines: readonly OrderProfitLine[];
  readonly confidence: ProfitConfidence;
  readonly diagnostics: readonly Diagnostic[];
}

/**
 * Reserved for defects in the *caller*, never for gaps in merchant data.
 *
 * Carries no totals and no lines, so a margin is structurally unrenderable on
 * this branch. It is a machine-readable dead-letter signal — and, unlike a
 * thrown exception, it is snapshot-testable in a golden fixture.
 */
export interface OrderProfitRejected {
  readonly status: 'rejected';
  readonly orderId: OrderId;
  readonly storeId: StoreId;
  readonly calcVersion: CalcVersion;
  /** At least one has severity `fatal`. */
  readonly diagnostics: readonly Diagnostic[];
}

export type OrderProfitResult = OrderProfitComputed | OrderProfitRejected;
