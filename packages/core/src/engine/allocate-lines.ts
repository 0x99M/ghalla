import { toMinor } from '@ghalla/contracts';
import type { CanonicalOrderItem, Minor, OrderItemId } from '@ghalla/contracts';
import { addMinor, allocateMinor, subMinor } from '../money.js';
import type { OrderProfitLine } from '../result.js';
import type { LineCogs } from './cogs.js';
import type { LineRevenue } from './revenue.js';
import type { LineReversal } from './reversal.js';
import type { ShipmentCost } from './shipping.js';

const ZERO = toMinor(0);

export interface OrderLevelAmounts {
  readonly shippingRevenueExVatMinor: Minor;
  readonly codFeeRevenueExVatMinor: Minor;
  readonly outboundParcels: readonly ShipmentCost[];
  readonly returnParcels: readonly ShipmentCost[];
  readonly outboundShippingCostMinor: Minor;
  readonly returnShippingCostMinor: Minor;
  readonly gatewayFeeCostMinor: Minor;
  readonly codCostMinor: Minor;
}

/**
 * Pushes order-level revenue and cost down onto lines.
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

  const itemById = new Map<OrderItemId, CanonicalOrderItem>(items.map((i) => [i.id, i]));

  /**
   * Weight on the ITEM's own line total, not on recognized revenue.
   *
   * `LineRevenue.grossExVatMinor` is zeroed for every line of a cost_only
   * order, which made the allocator fall through to its all-zero-weights path
   * and split freight EVENLY: a SAR 10 accessory carried the same courier cost
   * as a SAR 300 item on every RTO, and was then flagged as a loss-maker at
   * 220% of its own revenue. On a recognized order the two are equal, so this
   * changes nothing there.
   */
  const weightOf = (id: OrderItemId): Minor => itemById.get(id)?.lineTotalExVatMinor ?? ZERO;
  const buckets = revenue.map((line) => ({ key: line.orderItemId, weight: weightOf(line.orderItemId) }));
  const spread = (total: Minor): ReadonlyMap<string, Minor> => allocateMinor(total, buckets);

  /**
   * Freight per PARCEL, across only the lines that travelled in it.
   *
   * Revenue share is not a rough proxy for courier cost — it is anti-correlated
   * with it in exactly the multi-warehouse orders that produce split fulfilment.
   * A SAR 900 chain in a SAR 15 envelope and a SAR 100 kettlebell in a SAR 85
   * parcel come out 9000/1000 by revenue when the truth is 1500/8500, which
   * flips the kettlebell from a 71% loss to a 4% profit. Falls back to the
   * order-wide split when the platform does not report the mapping.
   */
  const spreadParcels = (parcels: readonly ShipmentCost[], total: Minor): ReadonlyMap<string, Minor> => {
    const mapped = parcels.filter((p) => p.lineIds.length > 0);
    if (parcels.length === 0 || mapped.length !== parcels.length) return spread(total);

    const out = new Map<string, Minor>(revenue.map((l) => [l.orderItemId, ZERO]));
    for (const parcel of parcels) {
      const inParcel = revenue.filter((l) => parcel.lineIds.includes(l.orderItemId));
      if (inParcel.length === 0) return spread(total);
      const share = allocateMinor(
        parcel.costMinor,
        inParcel.map((l) => ({ key: l.orderItemId, weight: weightOf(l.orderItemId) })),
      );
      for (const [key, amount] of share) {
        out.set(key, toMinor((out.get(key) ?? 0) + amount));
      }
    }
    return out;
  };

  /**
   * Return shipping lands on the lines that actually came back.
   *
   * Splitting it by revenue charges two SKUs the customer kept for a return leg
   * they had nothing to do with, and gives the SKU that caused the cost only
   * half of it — inside the per-SKU feature. Falls back to revenue share when
   * nothing was reversed, which is the RTO case where the whole order came back.
   */
  const returnedWeights = revenue.map((line) => ({
    key: line.orderItemId,
    weight: reversals.find((r) => r.orderItemId === line.orderItemId)?.reversedRevenueExVatMinor ?? ZERO,
  }));
  const anyReturned = returnedWeights.some((w) => w.weight > 0);

  const shippingRevenue = spread(amounts.shippingRevenueExVatMinor);
  const codFeeRevenue = spread(amounts.codFeeRevenueExVatMinor);
  const outbound = spreadParcels(amounts.outboundParcels, amounts.outboundShippingCostMinor);
  const returned = anyReturned
    ? allocateMinor(amounts.returnShippingCostMinor, returnedWeights)
    : spreadParcels(amounts.returnParcels, amounts.returnShippingCostMinor);
  const gateway = spread(amounts.gatewayFeeCostMinor);
  const cod = spread(amounts.codCostMinor);

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
