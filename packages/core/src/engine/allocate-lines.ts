import { toMinor } from '@ghalla/contracts';
import type { CanonicalOrderItem, Minor, OrderItemId } from '@ghalla/contracts';
import { addMinor, allocateMinor, subMinor } from '../money.js';
import type { OrderProfitLine } from '../result.js';
import type { LineCogs } from './cogs.js';
import type { LineRevenue } from './revenue.js';
import type { LineReversal } from './reversal.js';

const ZERO = toMinor(0);

export interface OrderLevelAmounts {
  readonly shippingRevenueExVatMinor: Minor;
  readonly codFeeRevenueExVatMinor: Minor;
  readonly outboundShippingCostMinor: Minor;
  readonly returnShippingCostMinor: Minor;
  readonly gatewayFeeCostMinor: Minor;
  readonly codCostMinor: Minor;
}

/**
 * Pushes order-level revenue and cost down onto lines by revenue share.
 *
 * Every allocation runs through the same largest-remainder allocator, so
 * `Σ(lines) === totals` holds EXACTLY rather than approximately. That is not
 * fastidiousness: if order profit and the sum of its SKU profits disagree by a
 * halala, a merchant eventually notices, and at that point every other number
 * on the page is in question.
 *
 * Allocation happens ONCE, at the level the order reconciles to, and is then
 * pushed down. Extraction and allocation are not additive — three lines of 33
 * extract to 87 while the 99 total extracts to 86 — so doing it per line and
 * summing up would make revenue disagree with the order total.
 */
export function allocateOrderCostsToLines(
  items: readonly CanonicalOrderItem[],
  revenue: readonly LineRevenue[],
  cogs: readonly LineCogs[],
  reversals: readonly LineReversal[],
  amounts: OrderLevelAmounts,
): readonly OrderProfitLine[] {
  if (revenue.length === 0) return [];

  const weights = revenue.map((line) => ({ key: line.orderItemId, weight: line.grossExVatMinor }));
  const spread = (total: Minor): ReadonlyMap<string, Minor> => allocateMinor(total, weights);

  const shippingRevenue = spread(amounts.shippingRevenueExVatMinor);
  const codFeeRevenue = spread(amounts.codFeeRevenueExVatMinor);
  const outbound = spread(amounts.outboundShippingCostMinor);
  const returned = spread(amounts.returnShippingCostMinor);
  const gateway = spread(amounts.gatewayFeeCostMinor);
  const cod = spread(amounts.codCostMinor);

  const itemById = new Map<OrderItemId, CanonicalOrderItem>(items.map((i) => [i.id, i]));
  const cogsById = new Map(cogs.map((c) => [c.orderItemId, c]));
  const reversalById = new Map(reversals.map((r) => [r.orderItemId, r]));

  return revenue.map((line) => {
    const id = line.orderItemId;
    const item = itemById.get(id);
    const lineCogs = cogsById.get(id);
    const lineReversal = reversalById.get(id);

    const allocatedShippingRevenue = shippingRevenue.get(id) ?? ZERO;
    const allocatedCodFeeRevenue = codFeeRevenue.get(id) ?? ZERO;
    const allocatedOutbound = outbound.get(id) ?? ZERO;
    const allocatedReturn = returned.get(id) ?? ZERO;
    const allocatedGateway = gateway.get(id) ?? ZERO;
    const allocatedCod = cod.get(id) ?? ZERO;
    const cogsMinor = lineCogs?.cogsMinor ?? ZERO;
    const reversalImpact = lineReversal?.impactMinor ?? ZERO;

    const margin = subMinor(
      addMinor(line.netExVatMinor, allocatedShippingRevenue, allocatedCodFeeRevenue, reversalImpact),
      addMinor(cogsMinor, allocatedOutbound, allocatedReturn, allocatedGateway, allocatedCod),
    );

    return {
      orderItemId: id,
      platformProductId: item?.platformProductId ?? '',
      platformVariantId: item?.platformVariantId ?? null,
      sku: item?.sku ?? null,
      quantity: item?.quantity ?? 0,

      allocatedOrderDiscountExVatMinor: line.allocatedOrderDiscountExVatMinor,
      netRevenueExVatMinor: line.netExVatMinor,
      allocatedShippingRevenueExVatMinor: allocatedShippingRevenue,
      allocatedCodFeeRevenueExVatMinor: allocatedCodFeeRevenue,

      unitCostMinor: lineCogs?.unitCostMinor ?? ZERO,
      cogsMinor,
      costSource: lineCogs?.source ?? 'none',
      costHistoryId: lineCogs?.costHistoryId ?? null,

      allocatedOutboundShippingMinor: allocatedOutbound,
      allocatedReturnShippingMinor: allocatedReturn,
      allocatedGatewayFeeMinor: allocatedGateway,
      allocatedCodCostMinor: allocatedCod,

      reversedQuantity: lineReversal?.reversedQuantity ?? 0,
      reversedRevenueExVatMinor: lineReversal?.reversedRevenueExVatMinor ?? ZERO,
      restockedCogsMinor: lineReversal?.restockedCogsMinor ?? ZERO,
      reversalImpactMinor: reversalImpact,

      contributionMarginMinor: margin,
      // The coverage numerator: a line counts only when its cost came from a
      // source that actually knows the cost. Stored as a numerator because
      // ratios do not aggregate across a rollup without weighting.
      costCoveredRevenueExVatMinor: lineCogs?.covered === true ? line.netExVatMinor : ZERO,
    };
  });
}
