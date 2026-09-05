import { toMinor } from '@ghalla/contracts';
import type { CanonicalReversal, CanonicalShipment, Minor, OrderItemId } from '@ghalla/contracts';
import type { Diagnostic } from '../diagnostics.js';
import { addMinor, allocateMinor, assertInRange, negateMinor } from '../money.js';
import { diagnostic, onOrder } from './diagnostics-builder.js';
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
  readonly allocated: boolean;
  /** True when a COGS credit was inferred from a shipment rather than reported. */
  readonly inferredRestock: boolean;
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
 * There is no `CanonicalReversal` to hang it on, because no money moved, which
 * is exactly why the returned SHIPMENT is the evidence. If the return leg has
 * not arrived, nothing is credited: the goods may come back damaged or not at
 * all, and overstating a loss is the survivable direction.
 *
 * Known limitation, deliberately left open: there is no CONDITION signal on the
 * return path — `RestockOutcome` lives only on `CanonicalReversal` — so a
 * refused parcel that comes back crushed still credits its full cost. The
 * inference is therefore reported as `inferredRestock`, which forces the COGS
 * term to `estimated` so such an order can never claim confidence `exact`.
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
 * arrive sellable overstates margin.
 */
export function computeReversalImpact(
  reversals: readonly CanonicalReversal[],
  revenueLines: readonly LineRevenue[],
  cogsLines: readonly LineCogs[],
  quantities: ReadonlyMap<OrderItemId, number>,
  /** Line weights from the ITEMS, so they survive a cost_only order zeroing revenue. */
  weights: ReadonlyMap<OrderItemId, Minor>,
  recognition: ProfitRecognition,
  shipments: readonly CanonicalShipment[],
  /** Whether anything actually left the warehouse. */
  dispatched: boolean,
): Computed<ReversalImpact> {
  const diagnostics: Diagnostic[] = [];
  const rtoRecovery = recognition.kind === 'cost_only' && recognition.reason === 'rto_uncollected';
  // Nothing dispatched means the stock never left the shelf, so booking it as
  // consumed reports a loss the merchant did not take. An order cancelled after
  // capture with an unfulfilled status costs the gateway fee, not the goods.
  const undispatchedRecovery =
    recognition.kind === 'cost_only' &&
    (recognition.reason === 'cancelled_after_capture' ||
      recognition.reason === 'cancelled_after_dispatch' ||
      recognition.reason === 'payment_not_settled') &&
    !dispatched;
  const cogsById = new Map(cogsLines.map((l) => [l.orderItemId, l]));
  const buckets = revenueLines.map((l) => ({ key: l.orderItemId, weight: weights.get(l.orderItemId) ?? ZERO }));

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
    allocated: false,
    inferredRestock: false,
  };

  const creditWholeOrder = (): Computed<ReversalImpact> => {
    const lines = revenueLines.map((line) => {
      const cogsBack = cogsById.get(line.orderItemId)?.cogsMinor ?? ZERO;
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
        allocated: false,
        inferredRestock: true,
      },
      diagnostics,
    };
  };

  if (undispatchedRecovery) return creditWholeOrder();

  if (rtoRecovery) {
    if (!rtoGoodsRecovered(shipments)) {
      diagnostics.push(onOrder('RESTOCK_UNKNOWN'));
      return { value: empty, diagnostics };
    }
    return creditWholeOrder();
  }

  if (reversals.length === 0) return { value: empty, diagnostics };

  const reversedRevenue = new Map<OrderItemId, number>(revenueLines.map((l) => [l.orderItemId, 0]));
  const reversedQty = new Map<OrderItemId, number>(revenueLines.map((l) => [l.orderItemId, 0]));
  const restocked = new Map<OrderItemId, number>(revenueLines.map((l) => [l.orderItemId, 0]));
  let allocated = false;

  const spread = (total: Minor, into: Map<OrderItemId, number>): void => {
    if (total === 0 || buckets.length === 0) return;
    for (const [key, amount] of allocateMinor(total, buckets)) {
      into.set(key as OrderItemId, (into.get(key as OrderItemId) ?? 0) + amount);
    }
  };

  for (const reversal of reversals) {
    const orderLevel = addMinor(
      reversal.shippingRefundExVatMinor,
      reversal.codFeeRefundExVatMinor,
      reversal.adjustmentExVatMinor,
    );

    if (reversal.lines !== null) {
      const claimed = addMinor(...reversal.lines.map((l) => l.amountExVatMinor));
      if (claimed !== reversal.amountExVatMinor) {
        // The contract says line amounts sum to the item revenue reversed.
        // Silently keeping the smaller figure loses refunded money in the
        // flattering direction.
        diagnostics.push(diagnostic('REVERSAL_TOTAL_MISMATCH', { kind: 'reversal', reversalId: reversal.id }));
        allocated = true;
      }

      let unmatched = 0;
      for (const line of reversal.lines) {
        if (!reversedRevenue.has(line.orderItemId)) {
          // Do NOT drop the money. A reversal line pointing at an item we do not
          // have still reversed real revenue; spreading it and flagging the
          // result is honest, deleting it is not.
          diagnostics.push(diagnostic('REVERSAL_LINE_UNMATCHED', { kind: 'reversal', reversalId: reversal.id }));
          unmatched += line.amountExVatMinor;
          allocated = true;
          continue;
        }
        reversedRevenue.set(
          line.orderItemId,
          (reversedRevenue.get(line.orderItemId) ?? 0) + line.amountExVatMinor,
        );

        // Bound the returned quantity by what was actually ordered, and bound
        // the COGS credit by the same rule — the clamp used to apply only to the
        // cosmetic field, so a quantity of 5 on a line ordered once credited 5x
        // its cost and turned a refund into profit.
        const ordered = quantities.get(line.orderItemId) ?? 0;
        const already = reversedQty.get(line.orderItemId) ?? 0;
        const creditable = Math.max(0, Math.min(line.quantity, ordered - already));
        reversedQty.set(line.orderItemId, already + creditable);

        if (UNKNOWN_RESTOCK.has(line.restockOutcome)) {
          diagnostics.push(diagnostic('RESTOCK_UNKNOWN', { kind: 'reversal', reversalId: reversal.id }));
        }
        if (RECOVERS_COGS.has(line.restockOutcome)) {
          const unit = cogsById.get(line.orderItemId)?.unitCostMinor ?? 0;
          restocked.set(line.orderItemId, (restocked.get(line.orderItemId) ?? 0) + unit * creditable);
        }
      }

      if (unmatched !== 0) spread(assertInRange(unmatched, 'unmatched reversal'), reversedRevenue);
      if (orderLevel !== 0) {
        // Shipping, COD-fee and goodwill components belong to no line, so the
        // per-SKU figures here are OUR arithmetic, not the platform's.
        diagnostics.push(diagnostic('REVERSAL_LINES_ALLOCATED', { kind: 'reversal', reversalId: reversal.id }));
        allocated = true;
        spread(orderLevel, reversedRevenue);
      }
      continue;
    }

    // No line detail at all: allocate by revenue share and say so.
    allocated = true;
    diagnostics.push(diagnostic('REVERSAL_LINES_ALLOCATED', { kind: 'reversal', reversalId: reversal.id }));
    if (UNKNOWN_RESTOCK.has(reversal.restockOutcome)) {
      diagnostics.push(diagnostic('RESTOCK_UNKNOWN', { kind: 'reversal', reversalId: reversal.id }));
    }

    spread(addMinor(reversal.amountExVatMinor, orderLevel), reversedRevenue);

    if (RECOVERS_COGS.has(reversal.restockOutcome)) {
      // PRORATED by the ITEM revenue reversed, never the whole order's COGS.
      // Crediting all of it made a partial refund raise profit, and a
      // shipping-only or goodwill refund — which returns no goods whatsoever —
      // credit every SKU's cost back.
      const itemsGross = addMinor(...buckets.map((b) => b.weight));
      if (reversal.amountExVatMinor > 0 && itemsGross > 0) {
        const fullCogs = addMinor(...cogsLines.map((l) => l.cogsMinor));
        const share = assertInRange(
          Math.floor((fullCogs * reversal.amountExVatMinor) / itemsGross),
          'prorated restock',
        );
        spread(share, restocked);
      }
    }
  }

  const lines = revenueLines.map((line) => {
    const ordered = quantities.get(line.orderItemId) ?? 0;
    const lineCogs = cogsById.get(line.orderItemId)?.cogsMinor ?? 0;
    const revenue =
      recognition.kind === 'recognized'
        ? assertInRange(reversedRevenue.get(line.orderItemId) ?? 0, 'reversed revenue')
        : ZERO;
    // You cannot get back more goods than you shipped. The cap closes both the
    // multi-reversal over-credit and any residue from proration rounding.
    const cogsBack = assertInRange(
      Math.max(0, Math.min(restocked.get(line.orderItemId) ?? 0, lineCogs)),
      'restocked COGS',
    );
    return {
      orderItemId: line.orderItemId,
      reversedQuantity: Math.min(reversedQty.get(line.orderItemId) ?? 0, ordered),
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
      allocated,
      inferredRestock: false,
    },
    diagnostics,
  };
}
