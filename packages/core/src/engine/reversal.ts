import { toMinor } from '@ghalla/contracts';
import type { CanonicalReversal, CanonicalShipment, Minor, OrderItemId } from '@ghalla/contracts';
import type { Diagnostic } from '../diagnostics.js';
import { addMinor, allocateMinor, assertInRange, negateMinor } from '../money.js';
import { diagnostic } from './diagnostics-builder.js';
import type { Computed } from './diagnostics-builder.js';
import type { LineCogs } from './cogs.js';
import type { LineRevenue } from './revenue.js';
import type { ProfitRecognition } from '../result.js';

const ZERO = toMinor(0);

export interface LineReversal {
  readonly orderItemId: OrderItemId;
  readonly reversedQuantity: number;
  readonly reversedRevenueExVatMinor: Minor;
  readonly restockedCogsMinor: Minor;
  readonly impactMinor: Minor;
}

export interface ReversalImpact {
  readonly lines: readonly LineReversal[];
  readonly reversedRevenueExVatMinor: Minor;
  readonly restockedCogsMinor: Minor;
  readonly impactMinor: Minor;
  readonly reported: boolean;
  readonly allocated: boolean;
}

/** Only goods that came back sellable recover their cost. */
const RECOVERS_COGS = new Set(['restocked_sellable']);
const UNKNOWN_RESTOCK = new Set(['pending_receipt', 'unknown']);

/** The parcel is physically back at the warehouse. */
const ARRIVED_BACK = new Set(['returned_to_origin', 'delivered']);

/**
 * On a return to origin the goods come back, so COGS is NOT a loss — the loss
 * is the two shipping legs.
 *
 * This matters more than it sounds. A refused cash-on-delivery parcel with the
 * goods counted as consumed reports a catastrophic margin that is simply
 * untrue, and RTO impact is a headline feature. There is no `CanonicalReversal`
 * to hang it on, because no money moved — which is exactly why the returned
 * SHIPMENT is the evidence.
 *
 * If the return leg has not arrived yet, nothing is credited: the goods may
 * come back damaged or not at all, and overstating a loss is the survivable
 * direction.
 */
export function rtoGoodsRecovered(shipments: readonly CanonicalShipment[]): boolean {
  return shipments.some((s) => s.direction === 'return' && ARRIVED_BACK.has(s.status));
}

/**
 * Money flowing back to the customer, and the goods that came back with it.
 *
 * Outbound shipping and gateway fees stay SUNK: a refunded order still paid to
 * ship and still paid to collect. Return shipping is deliberately not here — it
 * is its own term, because a return to origin produces no reversal at all and
 * would otherwise have nowhere to hang its cost.
 *
 * `pending_receipt` and `unknown` do not credit COGS back. At the moment a
 * refund is issued the goods are usually still in transit, and assuming they
 * arrive sellable overstates margin. Understating it is the safe direction.
 */
export function computeReversalImpact(
  reversals: readonly CanonicalReversal[],
  revenueLines: readonly LineRevenue[],
  cogsLines: readonly LineCogs[],
  quantities: ReadonlyMap<OrderItemId, number>,
  recognition: ProfitRecognition,
  shipments: readonly CanonicalShipment[],
): Computed<ReversalImpact> {
  const diagnostics: Diagnostic[] = [];
  const rtoRecovery = recognition.kind === 'cost_only' && recognition.reason === 'rto_uncollected';
  const empty: ReversalImpact = {
    lines: revenueLines.map((l) => ({
      orderItemId: l.orderItemId,
      reversedQuantity: 0,
      reversedRevenueExVatMinor: ZERO,
      restockedCogsMinor: ZERO,
      impactMinor: ZERO,
    })),
    reversedRevenueExVatMinor: ZERO,
    restockedCogsMinor: ZERO,
    impactMinor: ZERO,
    reported: false,
    allocated: false,
  };

  if (rtoRecovery) {
    // No money moved and no reversal exists, but the goods came back — or did
    // not, in which case say so rather than quietly assuming either way.
    const recovered = rtoGoodsRecovered(shipments);
    if (!recovered) {
      diagnostics.push({ code: 'RESTOCK_UNKNOWN', severity: 'warning', subject: { kind: 'order' } });
      return { value: empty, diagnostics };
    }
    const lines = revenueLines.map((line) => {
      const cogsBack = cogsLines.find((c) => c.orderItemId === line.orderItemId)?.cogsMinor ?? ZERO;
      return {
        orderItemId: line.orderItemId,
        reversedQuantity: quantities.get(line.orderItemId) ?? 0,
        reversedRevenueExVatMinor: ZERO,
        restockedCogsMinor: cogsBack,
        impactMinor: cogsBack,
      };
    });
    return {
      value: {
        lines,
        reversedRevenueExVatMinor: ZERO,
        restockedCogsMinor: addMinor(...lines.map((l) => l.restockedCogsMinor)),
        impactMinor: addMinor(...lines.map((l) => l.impactMinor)),
        reported: true,
        allocated: false,
      },
      diagnostics,
    };
  }

  if (reversals.length === 0) return { value: empty, diagnostics };

  const unitCost = new Map(cogsLines.map((l) => [l.orderItemId, l.unitCostMinor]));
  const reversedRevenue = new Map<OrderItemId, number>(revenueLines.map((l) => [l.orderItemId, 0]));
  const reversedQty = new Map<OrderItemId, number>(revenueLines.map((l) => [l.orderItemId, 0]));
  const restocked = new Map<OrderItemId, number>(revenueLines.map((l) => [l.orderItemId, 0]));
  let allocated = false;

  for (const reversal of reversals) {
    // Everything refunded ex-VAT was counted in revenue, so all of it reverses.
    const total = addMinor(
      reversal.amountExVatMinor,
      reversal.shippingRefundExVatMinor,
      reversal.codFeeRefundExVatMinor,
      reversal.adjustmentExVatMinor,
    );

    if (reversal.lines !== null) {
      for (const line of reversal.lines) {
        if (!reversedRevenue.has(line.orderItemId)) {
          diagnostics.push(diagnostic('REVERSAL_LINE_UNMATCHED', { kind: 'reversal', reversalId: reversal.id }));
          continue;
        }
        reversedRevenue.set(
          line.orderItemId,
          (reversedRevenue.get(line.orderItemId) ?? 0) + line.amountExVatMinor,
        );
        reversedQty.set(line.orderItemId, (reversedQty.get(line.orderItemId) ?? 0) + line.quantity);
        if (UNKNOWN_RESTOCK.has(line.restockOutcome)) {
          diagnostics.push(diagnostic('RESTOCK_UNKNOWN', { kind: 'reversal', reversalId: reversal.id }));
        }
        if (RECOVERS_COGS.has(line.restockOutcome)) {
          const unit = unitCost.get(line.orderItemId) ?? 0;
          restocked.set(line.orderItemId, (restocked.get(line.orderItemId) ?? 0) + unit * line.quantity);
        }
      }
      // Shipping, COD-fee and goodwill components belong to no line; spread
      // them by revenue share so the order total still ties.
      const orderLevel = addMinor(
        reversal.shippingRefundExVatMinor,
        reversal.codFeeRefundExVatMinor,
        reversal.adjustmentExVatMinor,
      );
      if (orderLevel !== 0 && revenueLines.length > 0) {
        const spread = allocateMinor(
          orderLevel,
          revenueLines.map((l) => ({ key: l.orderItemId, weight: l.grossExVatMinor })),
        );
        for (const [key, amount] of spread) {
          reversedRevenue.set(key as OrderItemId, (reversedRevenue.get(key as OrderItemId) ?? 0) + amount);
        }
      }
      continue;
    }

    // No line detail: allocate by revenue share and say so, because the result
    // is our arithmetic rather than the platform's report.
    allocated = true;
    diagnostics.push(diagnostic('REVERSAL_LINES_ALLOCATED', { kind: 'reversal', reversalId: reversal.id }));
    if (UNKNOWN_RESTOCK.has(reversal.restockOutcome)) {
      diagnostics.push(diagnostic('RESTOCK_UNKNOWN', { kind: 'reversal', reversalId: reversal.id }));
    }
    if (revenueLines.length === 0) continue;

    const spread = allocateMinor(
      total,
      revenueLines.map((l) => ({ key: l.orderItemId, weight: l.grossExVatMinor })),
    );
    for (const [key, amount] of spread) {
      reversedRevenue.set(key as OrderItemId, (reversedRevenue.get(key as OrderItemId) ?? 0) + amount);
    }

    if (RECOVERS_COGS.has(reversal.restockOutcome)) {
      const fullCogs = addMinor(...cogsLines.map((l) => l.cogsMinor));
      const share = total === 0 ? ZERO : fullCogs;
      const cogsSpread = allocateMinor(
        share,
        revenueLines.map((l) => ({ key: l.orderItemId, weight: l.grossExVatMinor })),
      );
      for (const [key, amount] of cogsSpread) {
        restocked.set(key as OrderItemId, (restocked.get(key as OrderItemId) ?? 0) + amount);
      }
    }
  }

  const lines = revenueLines.map((line) => {
    const qtyOrdered = quantities.get(line.orderItemId) ?? 0;
    const reverted = Math.min(reversedQty.get(line.orderItemId) ?? 0, qtyOrdered);
    // On a cost_only order no revenue was recognized, so there is none to reverse.
    const revenue =
      recognition.kind === 'recognized'
        ? assertInRange(reversedRevenue.get(line.orderItemId) ?? 0, 'reversed revenue')
        : ZERO;
    const cogsBack = assertInRange(restocked.get(line.orderItemId) ?? 0, 'restocked COGS');
    return {
      orderItemId: line.orderItemId,
      reversedQuantity: reverted,
      reversedRevenueExVatMinor: revenue,
      restockedCogsMinor: cogsBack,
      impactMinor: addMinor(negateMinor(revenue), cogsBack),
    };
  });

  return {
    value: {
      lines,
      reversedRevenueExVatMinor: addMinor(...lines.map((l) => l.reversedRevenueExVatMinor)),
      restockedCogsMinor: addMinor(...lines.map((l) => l.restockedCogsMinor)),
      impactMinor: addMinor(...lines.map((l) => l.impactMinor)),
      reported: !allocated,
      allocated,
    },
    diagnostics,
  };
}
