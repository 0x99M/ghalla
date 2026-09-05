import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RESTOCK_OUTCOMES, SHIPMENT_STATUSES, toInstant, toMinor } from '@ghalla/contracts';
import type {
  CanonicalOrder,
  CanonicalOrderItem,
  CanonicalReversal,
  CanonicalReversalLine,
  CanonicalShipment,
  Minor,
  OrderId,
  OrderItemId,
  RestockOutcome,
  ReversalId,
  ShipmentId,
} from '@ghalla/contracts';
import { computeOrderProfit } from '../src/compute-order-profit.js';
import type { Diagnostic } from '../src/diagnostics.js';
import type { ShippingFallbackRule } from '../src/fee-rules.js';
import type { OrderProfitInput } from '../src/input.js';
import type { ProfitRecognition } from '../src/result.js';
import { allocateOrderCostsToLines } from '../src/engine/allocate-lines.js';
import type { OrderLevelAmounts } from '../src/engine/allocate-lines.js';
import type { LineCogs } from '../src/engine/cogs.js';
import type { LineRevenue } from '../src/engine/revenue.js';
import { computeReversalImpact, rtoGoodsRecovered } from '../src/engine/reversal.js';
import type { LineReversal } from '../src/engine/reversal.js';
import { computeShippingCost, matchShippingRule } from '../src/engine/shipping.js';
import type { ShipmentCost } from '../src/engine/shipping.js';

const ZERO = toMinor(0);
const ORDER = 'demo:1:1001' as OrderId;
const L1 = 'demo:1:1001#L1' as OrderItemId;
const L2 = 'demo:1:1001#L2' as OrderItemId;
const L3 = 'demo:1:1001#L3' as OrderItemId;

/** One order line, in the three shapes the engine passes around separately. */
interface Sku {
  readonly id: OrderItemId;
  /** What the platform says the line is worth. Every allocation weights on this. */
  readonly lineTotalMinor: number;
  readonly unitCostMinor: number;
  readonly quantity: number;
}

const sku = (id: OrderItemId, lineTotalMinor: number, unitCostMinor: number, quantity = 1): Sku => ({
  id,
  lineTotalMinor,
  unitCostMinor,
  quantity,
});

const revenueOf = (s: Sku): LineRevenue => ({
  orderItemId: s.id,
  grossExVatMinor: toMinor(s.lineTotalMinor),
  allocatedOrderDiscountExVatMinor: ZERO,
  netExVatMinor: toMinor(s.lineTotalMinor),
});

/** What `computeRevenue` hands down for a cost_only order: every revenue term zeroed. */
const unrecognizedRevenueOf = (s: Sku): LineRevenue => ({
  orderItemId: s.id,
  grossExVatMinor: ZERO,
  allocatedOrderDiscountExVatMinor: ZERO,
  netExVatMinor: ZERO,
});

const cogsOf = (s: Sku): LineCogs => ({
  orderItemId: s.id,
  unitCostMinor: toMinor(s.unitCostMinor),
  cogsMinor: toMinor(s.unitCostMinor * s.quantity),
  source: 'merchant_manual',
  costHistoryId: null,
  covered: true,
});

const itemOf = (s: Sku): CanonicalOrderItem => ({
  id: s.id,
  orderId: ORDER,
  platformLineId: s.id,
  platformProductId: `P${s.id}`,
  platformVariantId: null,
  sku: `SKU${s.id}`,
  productName: 'منتج',
  quantity: s.quantity,
  unitPriceExVatMinor: toMinor(s.lineTotalMinor / s.quantity),
  grossLineExVatMinor: toMinor(s.lineTotalMinor),
  lineDiscountExVatMinor: ZERO,
  lineTotalExVatMinor: toMinor(s.lineTotalMinor),
});

const reversal = (over: Partial<CanonicalReversal> = {}): CanonicalReversal => ({
  id: 'demo:1:1001#rev:r1' as ReversalId,
  orderId: ORDER,
  platformReversalId: 'r1',
  kind: 'refund',
  reason: 'customer_return',
  rawReasonLabel: null,
  occurredAt: toInstant('2026-03-10T09:00:00.000Z'),
  amountExVatMinor: ZERO,
  shippingRefundExVatMinor: ZERO,
  codFeeRefundExVatMinor: ZERO,
  adjustmentExVatMinor: ZERO,
  vatMinor: ZERO,
  totalIncVatMinor: ZERO,
  lines: null,
  restockOutcome: 'not_applicable',
  platformUpdatedAt: null,
  ...over,
});

const refundLine = (
  orderItemId: OrderItemId,
  amountMinor: number,
  restockOutcome: RestockOutcome,
  quantity = 1,
): CanonicalReversalLine => ({
  orderItemId,
  quantity,
  amountExVatMinor: toMinor(amountMinor),
  restockOutcome,
});

const shipment = (over: Partial<CanonicalShipment> = {}): CanonicalShipment => ({
  id: 'demo:1:S1' as ShipmentId,
  orderId: ORDER,
  platformShipmentId: 'S1',
  direction: 'outbound',
  status: 'delivered',
  carrier: 'demo_courier',
  rawCarrierLabel: 'Demo Courier',
  carrierCostMinor: null,
  lines: [],
  shippedAt: null,
  deliveredAt: null,
  platformUpdatedAt: null,
  ...over,
});

const order = (over: Partial<CanonicalOrder> = {}): CanonicalOrder =>
  ({
    id: ORDER,
    lifecycle: 'open',
    paymentState: 'paid',
    fulfillmentState: 'delivered',
    fulfillmentMethod: 'carrier',
    destination: { countryCode: 'SA', region: 'riyadh', city: 'riyadh' },
    ...over,
  }) as CanonicalOrder;

const rule = (over: Partial<ShippingFallbackRule> = {}): ShippingFallbackRule => ({
  countryCode: null,
  region: null,
  carrier: null,
  direction: 'any',
  costMinor: toMinor(2200),
  ...over,
});

const parcel = (shipmentId: string, costMinor: number, lineIds: readonly string[]): ShipmentCost => ({
  shipmentId,
  costMinor: toMinor(costMinor),
  lineIds,
});

const amountsOf = (over: Partial<OrderLevelAmounts> = {}): OrderLevelAmounts => ({
  shippingRevenueExVatMinor: ZERO,
  codFeeRevenueExVatMinor: ZERO,
  outboundParcels: [],
  returnParcels: [],
  outboundShippingCostMinor: ZERO,
  returnShippingCostMinor: ZERO,
  gatewayFeeCostMinor: ZERO,
  codCostMinor: ZERO,
  ...over,
});

const codes = (diagnostics: readonly Diagnostic[]): readonly string[] => diagnostics.map((d) => d.code);

const lineOf = <T extends { readonly orderItemId: OrderItemId }>(lines: readonly T[], id: OrderItemId): T => {
  const found = lines.find((l) => l.orderItemId === id);
  if (found === undefined) throw new Error(`No line for ${id} in the result.`);
  return found;
};

interface Scene {
  readonly recognition?: ProfitRecognition;
  readonly shipments?: readonly CanonicalShipment[];
  readonly dispatched?: boolean;
}

const impactOf = (skus: readonly Sku[], reversals: readonly CanonicalReversal[], scene: Scene = {}) =>
  computeReversalImpact(
    reversals,
    skus.map(revenueOf),
    skus.map(cogsOf),
    new Map(skus.map((s) => [s.id, s.quantity])),
    new Map<OrderItemId, Minor>(skus.map((s) => [s.id, toMinor(s.lineTotalMinor)])),
    scene.recognition ?? { kind: 'recognized' },
    scene.shipments ?? [],
    scene.dispatched ?? true,
  );

// A SAR 300 item and a SAR 100 one, so a revenue-weighted split is a clean 3:1.
const CHEAP = sku(L1, 10000, 4000);
const DEAR = sku(L2, 30000, 9000);

describe('a reversal that carries line detail', () => {
  it('spreads a refunded shipping charge across the lines and says the per-SKU figures are its own', () => {
    const { value, diagnostics } = impactOf(
      [CHEAP, DEAR],
      [
        reversal({
          amountExVatMinor: toMinor(30000),
          shippingRefundExVatMinor: toMinor(2000),
          lines: [refundLine(L2, 30000, 'restocked_sellable')],
        }),
      ],
    );

    // Refunded shipping belongs to no line, so the 20 SAR has to be allocated —
    // 3:1 by line value — and the order must say so, because these per-SKU
    // numbers are the engine's arithmetic rather than the platform's.
    expect(lineOf(value.lines, L1).reversedRevenueExVatMinor).toBe(500);
    expect(lineOf(value.lines, L2).reversedRevenueExVatMinor).toBe(31500);
    expect(value.allocated).toBe(true);
    expect(codes(diagnostics)).toEqual(['REVERSAL_LINES_ALLOCATED']);

    // Every halala the reversal moved is still accounted for after the split.
    expect(value.reversedRevenueExVatMinor).toBe(32000);
    expect(value.impactMinor).toBe(-32000 + 9000);
  });

  it('leaves a purely itemised refund reported rather than allocated', () => {
    // Nothing here belongs to the order as a whole, so no arithmetic of ours
    // enters the per-SKU figures and confidence must not be downgraded.
    const { value, diagnostics } = impactOf(
      [CHEAP, DEAR],
      [
        reversal({
          amountExVatMinor: toMinor(30000),
          lines: [refundLine(L2, 30000, 'restocked_sellable')],
        }),
      ],
    );

    expect(value.allocated).toBe(false);
    expect(diagnostics).toEqual([]);
    expect(lineOf(value.lines, L1).reversedRevenueExVatMinor).toBe(0);
    expect(lineOf(value.lines, L2).reversedRevenueExVatMinor).toBe(30000);
  });

  it('flags a reversal whose lines do not sum to the amount it claims to have moved', () => {
    const { value, diagnostics } = impactOf(
      [CHEAP, DEAR],
      [
        reversal({
          amountExVatMinor: toMinor(30000),
          lines: [refundLine(L2, 25000, 'restocked_sellable')],
        }),
      ],
    );

    expect(codes(diagnostics)).toEqual(['REVERSAL_TOTAL_MISMATCH']);
    // The line detail is no longer trustworthy as a per-SKU statement, so the
    // order may not claim confidence `exact` on the strength of it.
    expect(value.allocated).toBe(true);
  });

  it('keeps the money a short-summing reversal says it moved', () => {
    // The reversal's own total is the figure that ties to the cash — the
    // reconciliation identity builds `totalIncVatMinor` from it. Keeping the
    // smaller line sum drops SAR 50 of refund in the direction that flatters
    // margin, which is precisely what the unmatched-line branch refuses to do.
    const { value } = impactOf(
      [CHEAP, DEAR],
      [
        reversal({
          amountExVatMinor: toMinor(30000),
          lines: [refundLine(L2, 25000, 'restocked_sellable')],
        }),
      ],
    );

    expect(value.reversedRevenueExVatMinor).toBe(30000);
  });

  it('spreads a refund line that points at an item the order does not have', () => {
    const { value, diagnostics } = impactOf(
      [CHEAP, DEAR],
      [
        reversal({
          amountExVatMinor: toMinor(4000),
          lines: [refundLine('demo:1:1001#L9' as OrderItemId, 4000, 'restocked_sellable')],
        }),
      ],
    );

    // Dropping it would be byte-identical to the order having no reversal at
    // all: SAR 40 of refunded revenue simply gone, with the margin improved by
    // exactly that much.
    expect(value.reversedRevenueExVatMinor).toBe(4000);
    expect(lineOf(value.lines, L1).reversedRevenueExVatMinor).toBe(1000);
    expect(lineOf(value.lines, L2).reversedRevenueExVatMinor).toBe(3000);
    expect(codes(diagnostics)).toEqual(['REVERSAL_LINE_UNMATCHED']);
    expect(value.allocated).toBe(true);

    // An item we cannot identify has no cost to credit back, whatever the line
    // claims about its restock outcome.
    expect(value.restockedCogsMinor).toBe(0);
  });

  it('credits back only as many units as were ordered, however many the refund claims', () => {
    const twoOrdered = sku(L1, 20000, 4000, 2);
    const { value } = impactOf(
      [twoOrdered],
      [
        reversal({
          amountExVatMinor: toMinor(10000),
          lines: [refundLine(L1, 10000, 'restocked_sellable', 5)],
        }),
      ],
    );

    // Five returned against two shipped used to credit five units of cost and
    // turn a refund into profit, because the clamp reached only the cosmetic
    // quantity field and not the one that moves money.
    expect(lineOf(value.lines, L1).reversedQuantity).toBe(2);
    expect(value.restockedCogsMinor).toBe(8000);
  });

  it('cannot return the same unit twice across two reversals', () => {
    const { value } = impactOf(
      [sku(L1, 10000, 4000)],
      [
        reversal({
          id: 'demo:1:1001#rev:r1' as ReversalId,
          amountExVatMinor: toMinor(5000),
          lines: [refundLine(L1, 5000, 'restocked_sellable')],
        }),
        reversal({
          id: 'demo:1:1001#rev:r2' as ReversalId,
          amountExVatMinor: toMinor(5000),
          lines: [refundLine(L1, 5000, 'restocked_sellable')],
        }),
      ],
    );

    // Two half refunds of a single unit return one unit of stock. Crediting
    // both produced a contribution margin above 100% on a sale with real COGS.
    expect(value.restockedCogsMinor).toBe(4000);
    expect(lineOf(value.lines, L1).reversedQuantity).toBe(1);
    expect(value.impactMinor).toBe(-10000 + 4000);
  });

  it('credits cost back only for goods that came back sellable, and says so when it cannot know', () => {
    const observed = RESTOCK_OUTCOMES.map((outcome) => {
      const { value, diagnostics } = impactOf(
        [sku(L1, 10000, 4000)],
        [reversal({ amountExVatMinor: toMinor(10000), lines: [refundLine(L1, 10000, outcome)] })],
      );
      return [outcome, value.restockedCogsMinor, codes(diagnostics)];
    });

    // At the moment a refund is issued the goods are usually still in transit,
    // so `pending_receipt` and `unknown` credit nothing and raise the flag that
    // stops the order claiming `exact`. Damaged and not-restocked stock is a
    // real loss and credits nothing either, silently — there is nothing to warn
    // the merchant about.
    expect(observed).toEqual([
      ['restocked_sellable', 4000, []],
      ['restocked_damaged', 0, []],
      ['not_restocked', 0, []],
      ['pending_receipt', 0, ['RESTOCK_UNKNOWN']],
      ['not_applicable', 0, []],
      ['unknown', 0, ['RESTOCK_UNKNOWN']],
    ]);
  });
});

describe('a reversal with no line detail', () => {
  it('prorates the cost credit by the item revenue actually refunded', () => {
    const { value, diagnostics } = impactOf(
      [sku(L1, 30000, 15000), sku(L2, 10000, 5000)],
      [reversal({ amountExVatMinor: toMinor(10000), restockOutcome: 'restocked_sellable' })],
    );

    // A quarter of the items came back, so a quarter of the cost does. Crediting
    // the whole order's COGS made a SAR 110 refund on a SAR 330 order leave it
    // MORE profitable than never refunding at all.
    expect(value.restockedCogsMinor).toBe(5000);
    expect(value.reversedRevenueExVatMinor).toBe(10000);
    expect(value.impactMinor).toBe(-5000);
    expect(codes(diagnostics)).toEqual(['REVERSAL_LINES_ALLOCATED']);
    expect(value.allocated).toBe(true);
  });

  it('credits no cost at all for a refund that returned no goods', () => {
    const skus = [sku(L1, 30000, 15000), sku(L2, 10000, 5000)];
    const shippingOnly = impactOf(skus, [
      reversal({ shippingRefundExVatMinor: toMinor(2000), restockOutcome: 'restocked_sellable' }),
    ]);
    const codFeeOnly = impactOf(skus, [
      reversal({ codFeeRefundExVatMinor: toMinor(1150), restockOutcome: 'restocked_sellable' }),
    ]);
    const goodwillOnly = impactOf(skus, [
      reversal({ adjustmentExVatMinor: toMinor(5000), restockOutcome: 'restocked_sellable' }),
    ]);

    // Refunding the delivery charge or the cash-handling fee, or making a
    // goodwill gesture on an order the customer kept, returns nothing to the
    // warehouse. Keying the credit on the item amount alone is what stops
    // `restocked_sellable` crediting every SKU's cost back on a refund that
    // touched no SKU.
    expect(shippingOnly.value.restockedCogsMinor).toBe(0);
    expect(shippingOnly.value.impactMinor).toBe(-2000);
    expect(codFeeOnly.value.restockedCogsMinor).toBe(0);
    expect(codFeeOnly.value.impactMinor).toBe(-1150);
    expect(goodwillOnly.value.restockedCogsMinor).toBe(0);
    expect(goodwillOnly.value.impactMinor).toBe(-5000);
  });

  it('credits cost back only for goods that came back sellable, and says so when it cannot know', () => {
    const observed = RESTOCK_OUTCOMES.map((outcome) => {
      const { value, diagnostics } = impactOf(
        [sku(L1, 10000, 4000)],
        [reversal({ amountExVatMinor: toMinor(10000), restockOutcome: outcome })],
      );
      return [outcome, value.restockedCogsMinor, codes(diagnostics)];
    });

    expect(observed).toEqual([
      ['restocked_sellable', 4000, ['REVERSAL_LINES_ALLOCATED']],
      ['restocked_damaged', 0, ['REVERSAL_LINES_ALLOCATED']],
      ['not_restocked', 0, ['REVERSAL_LINES_ALLOCATED']],
      ['pending_receipt', 0, ['REVERSAL_LINES_ALLOCATED', 'RESTOCK_UNKNOWN']],
      ['not_applicable', 0, ['REVERSAL_LINES_ALLOCATED']],
      ['unknown', 0, ['REVERSAL_LINES_ALLOCATED', 'RESTOCK_UNKNOWN']],
    ]);
  });

  it('returns the whole order’s cost to stock when the whole order is refunded', () => {
    // Both SKUs came back sellable and every halala of item revenue was
    // refunded, so the merchant is holding all SAR 90 of stock again. The
    // revenue-weighted spread puts SAR 67.50 of credit on a line whose own cost
    // is SAR 10, the per-line cap discards the excess, and the order reports a
    // SAR 57.50 loss that never happened.
    const { value } = impactOf(
      [sku(L1, 30000, 1000), sku(L2, 10000, 8000)],
      [reversal({ amountExVatMinor: toMinor(40000), restockOutcome: 'restocked_sellable' })],
    );

    expect(value.restockedCogsMinor).toBe(9000);
  });

  it('does not dead-letter an order whose items never arrived', () => {
    // There is nothing to allocate across, and the allocator throws rather than
    // invent a bucket. An order with no items must still return a result: it is
    // the shape that says an adapter dropped the lines.
    const { value } = computeReversalImpact(
      [reversal({ amountExVatMinor: toMinor(5000) })],
      [],
      [],
      new Map(),
      new Map(),
      { kind: 'recognized' },
      [],
      true,
    );

    expect(value.lines).toEqual([]);
    expect(value.impactMinor).toBe(0);
  });
});

describe('goods that come back without a reversal record', () => {
  it('treats a return leg as evidence only once the parcel has actually arrived', () => {
    const observed = SHIPMENT_STATUSES.map((status) => [
      status,
      rtoGoodsRecovered([shipment({ direction: 'return', status })]),
      rtoGoodsRecovered([shipment({ direction: 'outbound', status })]),
    ]);

    // In transit, the goods may still come back damaged or not at all, and
    // overstating a loss is the survivable direction. An outbound leg is never
    // evidence of recovery whatever its status says.
    expect(observed).toEqual([
      ['created', false, false],
      ['in_transit', false, false],
      ['out_for_delivery', false, false],
      ['delivered', true, false],
      ['failed_attempt', false, false],
      ['returned_to_origin', true, false],
      ['cancelled', false, false],
      ['lost', false, false],
      ['unknown', false, false],
    ]);
  });

  it('takes the refused parcel’s stock back out of the loss', () => {
    const { value, diagnostics } = impactOf([sku(L1, 30000, 15000), sku(L2, 10000, 5000)], [], {
      recognition: { kind: 'cost_only', reason: 'rto_uncollected' },
      shipments: [shipment({ direction: 'return', status: 'returned_to_origin' })],
    });

    // The case the three-axis status model exists for. No money moved, so there
    // is no reversal to hang this on — but the item is on the shelf again, and
    // booking its cost as consumed reports SAR 164 of loss where the truth is
    // the two shipping legs.
    expect(value.restockedCogsMinor).toBe(20000);
    expect(value.impactMinor).toBe(20000);
    expect(lineOf(value.lines, L1).reversedQuantity).toBe(1);
    expect(value.reversedRevenueExVatMinor).toBe(0);
    expect(diagnostics).toEqual([]);

    // Inferred from a shipment status rather than reported: there is no
    // condition signal on a return leg, so the order can never be `exact`.
    expect(value.inferredRestock).toBe(true);
  });

  it('credits nothing while the refused parcel is still in transit', () => {
    const { value, diagnostics } = impactOf([sku(L1, 30000, 15000)], [], {
      recognition: { kind: 'cost_only', reason: 'rto_uncollected' },
      shipments: [shipment({ direction: 'return', status: 'in_transit' })],
    });

    expect(value.restockedCogsMinor).toBe(0);
    expect(value.impactMinor).toBe(0);
    expect(codes(diagnostics)).toEqual(['RESTOCK_UNKNOWN']);
    expect(value.inferredRestock).toBe(false);
  });

  it('credits stock back when nothing ever left the shelf', () => {
    const skus = [sku(L1, 30000, 15000), sku(L2, 10000, 5000)];
    const reasons = ['cancelled_after_capture', 'payment_not_settled'] as const;

    // An order cancelled after capture but never dispatched costs the gateway
    // fee, not the goods. Booking SAR 200 of COGS reports a loss the merchant
    // did not take, on stock still in the warehouse.
    for (const reason of reasons) {
      const { value } = impactOf(skus, [], {
        recognition: { kind: 'cost_only', reason },
        dispatched: false,
      });
      expect(value.restockedCogsMinor).toBe(20000);
      expect(value.impactMinor).toBe(20000);
      expect(value.inferredRestock).toBe(true);
    }
  });

  it('does not credit stock that has already gone out', () => {
    const skus = [sku(L1, 30000, 15000), sku(L2, 10000, 5000)];
    const reasons = ['cancelled_after_capture', 'cancelled_after_dispatch'] as const;

    // Once the parcel is with the courier the goods are genuinely gone until a
    // return leg says otherwise, and a cancellation is not that evidence.
    for (const reason of reasons) {
      const { value } = impactOf(skus, [], {
        recognition: { kind: 'cost_only', reason },
        dispatched: true,
      });
      expect(value.restockedCogsMinor).toBe(0);
      expect(value.impactMinor).toBe(0);
    }
  });

  it('does not reverse revenue an order never recognized', () => {
    const { value } = impactOf(
      [sku(L1, 30000, 15000)],
      [
        reversal({
          amountExVatMinor: toMinor(30000),
          lines: [refundLine(L1, 30000, 'restocked_sellable')],
        }),
      ],
      { recognition: { kind: 'cost_only', reason: 'cancelled_after_capture' }, dispatched: true },
    );

    // A cost-only order books no revenue, so subtracting the refund as well
    // would remove SAR 300 the merchant was never credited with. The returned
    // stock is still real and still counts.
    expect(value.reversedRevenueExVatMinor).toBe(0);
    expect(value.restockedCogsMinor).toBe(15000);
    expect(value.impactMinor).toBe(15000);
  });
});

describe('matching a shipping rate card', () => {
  const CATCH_ALL = rule({ costMinor: toMinor(2200) });
  const NATIONAL = rule({ countryCode: 'SA', costMinor: toMinor(2000) });
  const REGIONAL = rule({ countryCode: 'SA', region: 'riyadh', costMinor: toMinor(1800) });
  const BY_CARRIER = rule({ countryCode: 'SA', region: 'riyadh', carrier: 'demo_courier', costMinor: toMinor(1500) });

  it('prefers a rate written for returns over a national rate, on a return leg only', () => {
    const rules = [NATIONAL, rule({ direction: 'return', costMinor: toMinor(3400) })];

    // Direction is a filter, not one more point of specificity. A merchant who
    // adds their RTO rate on top of a blended national one otherwise keeps
    // paying the blended rate on every return — the upgrade path onboarding
    // promises, quietly not working.
    expect(matchShippingRule(rules, order(), null, 'return')?.costMinor).toBe(3400);
    expect(matchShippingRule(rules, order(), null, 'outbound')?.costMinor).toBe(2000);
  });

  it('never prices an outbound parcel from a return-only rate', () => {
    const rules = [rule({ direction: 'return', costMinor: toMinor(3400) })];
    expect(matchShippingRule(rules, order(), null, 'outbound')).toBeNull();
  });

  it('takes the most specific geography that actually matches the destination', () => {
    const rules = [CATCH_ALL, NATIONAL, REGIONAL, BY_CARRIER];

    expect(matchShippingRule(rules, order(), 'demo_courier', 'outbound')?.costMinor).toBe(1500);
    // The carrier row loses because its carrier does not match, not because it
    // scores low — so the next most specific row wins rather than the catch-all.
    expect(matchShippingRule(rules, order(), 'other_courier', 'outbound')?.costMinor).toBe(1800);

    const jeddah = order({ destination: { countryCode: 'SA', region: 'jeddah', city: 'jeddah' } });
    expect(matchShippingRule(rules, jeddah, 'demo_courier', 'outbound')?.costMinor).toBe(2000);

    const abroad = order({ destination: { countryCode: 'AE', region: 'dubai', city: 'dubai' } });
    expect(matchShippingRule(rules, abroad, 'demo_courier', 'outbound')?.costMinor).toBe(2200);
  });

  it('treats a row with every key null as a real rate, not a degenerate one', () => {
    // It is the single blended per-shipment number a merchant types at
    // onboarding, and it has to price every order until they add a rate card.
    expect(matchShippingRule([CATCH_ALL], order(), null, 'outbound')?.costMinor).toBe(2200);
  });

  it('returns nothing rather than the nearest miss', () => {
    const rules = [rule({ countryCode: 'AE', costMinor: toMinor(9000) })];
    expect(matchShippingRule(rules, order(), null, 'outbound')).toBeNull();
  });

  it('is order-independent on any rule set validation would allow through', () => {
    // Specificity is a bijection on which fields are set, so two matching rules
    // can only TIE when their keys are identical — and a rule set containing
    // that pair is now rejected as DUPLICATE_RULE_KEY before it reaches here
    // (see engine-validation.test.ts). Freight is the largest cost line in the
    // model, so which of the two applied must never come down to the order a
    // query returned.
    //
    // What this asserts is the contract that survives: given a set with no
    // duplicate keys, the match does not depend on their order.
    const rules = [
      rule({ costMinor: toMinor(2200) }),
      rule({ countryCode: 'SA', costMinor: toMinor(3400) }),
      rule({ direction: 'return', costMinor: toMinor(5000) }),
    ];

    expect(matchShippingRule(rules, order(), null, 'outbound')?.costMinor).toBe(
      matchShippingRule([...rules].reverse(), order(), null, 'outbound')?.costMinor,
    );
    expect(matchShippingRule(rules, order(), null, 'return')?.costMinor).toBe(
      matchShippingRule([...rules].reverse(), order(), null, 'return')?.costMinor,
    );
  });
});

describe('what a shipment costs', () => {
  const RULES = [rule({ costMinor: toMinor(2200) })];

  it('keeps a courier charge the platform actually reported on a pickup order', () => {
    const pickup = order({ fulfillmentMethod: 'pickup' });
    const { value, diagnostics } = computeShippingCost(
      pickup,
      [shipment({ carrierCostMinor: toMinor(2100) })],
      RULES,
      'outbound',
    );

    // SAR 21 of reported cost was being deleted because the order was labelled
    // pickup. A settled charge is a fact; the fulfilment method exists to stop
    // the engine INVENTING one, which is a different thing.
    expect(value.costMinor).toBe(2100);
    expect(value.basis).toBe('actual');
    expect(diagnostics).toEqual([]);
  });

  it('invents no courier charge for a pickup order that has none', () => {
    const pickup = order({ fulfillmentMethod: 'pickup' });
    const { value, diagnostics } = computeShippingCost(pickup, [shipment()], RULES, 'outbound');

    expect(value.costMinor).toBe(0);
    // Missing rather than not_applicable: the parcel exists and cost something,
    // we simply cannot say what, so the margin is a bound and not a number.
    expect(value.basis).toBe('missing');
    expect(codes(diagnostics)).toEqual(['CARRIER_COST_MISSING']);
  });

  it('says nothing at all about a pickup order with no parcel', () => {
    const pickup = order({ fulfillmentMethod: 'pickup' });
    const { value, diagnostics } = computeShippingCost(pickup, [], RULES, 'outbound');

    expect(value).toEqual({ costMinor: 0, basis: 'not_applicable', parcels: [] });
    expect(diagnostics).toEqual([]);
  });

  it('invents nothing for an order cancelled before it was ever dispatched', () => {
    const cancelled = order({ lifecycle: 'cancelled', fulfillmentState: 'unfulfilled' });
    const { value, diagnostics } = computeShippingCost(cancelled, [], RULES, 'outbound');

    // The fallback's justification is that shipment facts land days after the
    // order — which is about an OPEN order, and this one will never become one
    // again. Estimating here charged SAR 22 of freight for a parcel that never
    // existed, on top of the COGS the same order used to book.
    expect(value).toEqual({ costMinor: 0, basis: 'not_applicable', parcels: [] });
    expect(diagnostics).toEqual([]);
  });

  it('still estimates for an order cancelled after the parcel went out', () => {
    const cancelled = order({ lifecycle: 'cancelled', fulfillmentState: 'in_transit' });
    const { value, diagnostics } = computeShippingCost(cancelled, [], RULES, 'outbound');

    expect(value.costMinor).toBe(2200);
    expect(value.basis).toBe('estimated');
    expect(codes(diagnostics)).toEqual(['NO_OUTBOUND_SHIPMENT', 'SHIPPING_FALLBACK_USED']);
  });

  it('reports the gap when an order has no parcel and the rate card has no row for it', () => {
    const { value, diagnostics } = computeShippingCost(order(), [], [], 'outbound');

    expect(value).toEqual({ costMinor: 0, basis: 'missing', parcels: [] });
    expect(codes(diagnostics)).toEqual(['NO_OUTBOUND_SHIPMENT', 'SHIPPING_FALLBACK_MISSING']);
  });

  it('reports the gap against the parcel when the rate card cannot price it', () => {
    const rules = [rule({ countryCode: 'AE' })];
    const { value, diagnostics } = computeShippingCost(order(), [shipment()], rules, 'outbound');

    expect(value).toEqual({ costMinor: 0, basis: 'missing', parcels: [] });
    expect(codes(diagnostics)).toEqual(['CARRIER_COST_MISSING', 'SHIPPING_FALLBACK_MISSING']);
    // Named against the shipment, not the order: the merchant's remedy is a
    // rate for this destination and courier, not a rate in general.
    expect(diagnostics.map((d) => d.subject)).toEqual([
      { kind: 'shipment', shipmentId: 'demo:1:S1' },
      { kind: 'shipment', shipmentId: 'demo:1:S1' },
    ]);
  });

  it('charges for every parcel that moved and nothing for one cancelled before collection', () => {
    const observed = SHIPMENT_STATUSES.map((status) => {
      const { value } = computeShippingCost(
        order(),
        [shipment({ status, carrierCostMinor: toMinor(1800) })],
        [],
        'outbound',
      );
      return [status, value.costMinor, value.basis];
    });

    // A cancelled label is the one status that never became a parcel. The order
    // then looks as though it has no outbound leg at all, which is the honest
    // reading — and with no rate card to fall back on, the term is missing.
    expect(observed).toEqual([
      ['created', 1800, 'actual'],
      ['in_transit', 1800, 'actual'],
      ['out_for_delivery', 1800, 'actual'],
      ['delivered', 1800, 'actual'],
      ['failed_attempt', 1800, 'actual'],
      ['returned_to_origin', 1800, 'actual'],
      ['cancelled', 0, 'missing'],
      ['lost', 1800, 'actual'],
      ['unknown', 1800, 'actual'],
    ]);
  });

  it('never invents a return leg for an order that has none', () => {
    const { value, diagnostics } = computeShippingCost(order(), [shipment()], RULES, 'return');

    // Estimating return freight for every order would charge the whole book for
    // a return rate on parcels nobody sent back.
    expect(value).toEqual({ costMinor: 0, basis: 'not_applicable', parcels: [] });
    expect(diagnostics).toEqual([]);
  });

  it('carries each parcel’s own cost so freight can follow the goods', () => {
    const shipments = [
      shipment({
        id: 'demo:1:S1' as ShipmentId,
        carrierCostMinor: toMinor(1500),
        lines: [{ orderItemId: L1, quantity: 1 }],
      }),
      shipment({
        id: 'demo:1:S2' as ShipmentId,
        carrierCostMinor: toMinor(8500),
        lines: [{ orderItemId: L2, quantity: 1 }],
      }),
    ];
    const { value } = computeShippingCost(order(), shipments, RULES, 'outbound');

    // Split fulfilment: the totals alone cannot tell the allocator that the
    // cheap heavy item travelled in the expensive parcel.
    expect(value.parcels).toEqual([
      { shipmentId: 'demo:1:S1', costMinor: 1500, lineIds: [L1] },
      { shipmentId: 'demo:1:S2', costMinor: 8500, lineIds: [L2] },
    ]);
    expect(value.costMinor).toBe(10000);
    expect(value.basis).toBe('actual');
  });

  it('marks the whole leg an estimate when one parcel was priced from the rate card', () => {
    const shipments = [
      shipment({ id: 'demo:1:S1' as ShipmentId, carrierCostMinor: toMinor(1800) }),
      shipment({ id: 'demo:1:S2' as ShipmentId }),
    ];
    const { value, diagnostics } = computeShippingCost(order(), shipments, RULES, 'outbound');

    expect(value.costMinor).toBe(4000);
    expect(value.basis).toBe('estimated');
    expect(codes(diagnostics)).toEqual(['CARRIER_COST_MISSING', 'SHIPPING_FALLBACK_USED']);
  });

  it('marks the leg missing when one parcel cannot be priced at all, however many settled', () => {
    const shipments = [
      shipment({ id: 'demo:1:S1' as ShipmentId, carrierCostMinor: toMinor(1800) }),
      shipment({ id: 'demo:1:S2' as ShipmentId, carrier: 'other_courier' }),
    ];
    const rules = [rule({ carrier: 'demo_courier' })];
    const { value } = computeShippingCost(order(), shipments, rules, 'outbound');

    // The reported SAR 18 is still counted — a fact is a fact — but the term is
    // a bound, so this order must not rank as a loss-maker on it.
    expect(value.costMinor).toBe(1800);
    expect(value.basis).toBe('missing');
  });
});

describe('pushing order-level money down onto the lines', () => {
  // A SAR 900 chain in a SAR 15 envelope, a SAR 100 kettlebell in a SAR 85 parcel.
  const CHAIN = sku(L1, 90000, 0);
  const KETTLEBELL = sku(L2, 10000, 0);
  const SPLIT = [CHAIN, KETTLEBELL];

  const allocate = (
    skus: readonly Sku[],
    amounts: OrderLevelAmounts,
    reversals: readonly LineReversal[] = [],
  ) => allocateOrderCostsToLines(skus.map(itemOf), skus.map(revenueOf), skus.map(cogsOf), reversals, amounts);

  const freightOf = (skus: readonly Sku[], amounts: OrderLevelAmounts): readonly (readonly [string, Minor])[] =>
    allocate(skus, amounts).map((l) => [l.orderItemId, l.allocatedOutboundShippingMinor] as const);

  it('charges each parcel’s freight to the goods that travelled in it', () => {
    const observed = freightOf(
      SPLIT,
      amountsOf({
        outboundShippingCostMinor: toMinor(10000),
        outboundParcels: [parcel('S1', 1500, [L1]), parcel('S2', 8500, [L2])],
      }),
    );

    // Revenue share is not a rough proxy here, it is anti-correlated: by revenue
    // the kettlebell carries SAR 10 of the SAR 100 freight and reports a small
    // profit, when it actually cost SAR 85 to ship and lost 71%.
    expect(observed).toEqual([
      [L1, 1500],
      [L2, 8500],
    ]);
  });

  it('falls back to revenue share when only some parcels reported their lines', () => {
    const observed = freightOf(
      SPLIT,
      amountsOf({
        outboundShippingCostMinor: toMinor(10000),
        outboundParcels: [parcel('S1', 1500, [L1]), parcel('S2', 8500, [])],
      }),
    );

    // Half a mapping is not evidence. Attributing the parcel that reported and
    // guessing at the other would state a per-SKU freight number with more
    // confidence than the platform earned.
    expect(observed).toEqual([
      [L1, 9000],
      [L2, 1000],
    ]);
  });

  it('falls back rather than dropping freight for a parcel that names an unknown line', () => {
    const observed = freightOf(
      SPLIT,
      amountsOf({
        outboundShippingCostMinor: toMinor(10000),
        outboundParcels: [parcel('S1', 10000, ['demo:1:1001#L9'])],
      }),
    );

    // The mapping is unusable, but the SAR 100 was still paid, and Σ(lines)
    // must equal the order total whatever the adapter got wrong.
    expect(observed).toEqual([
      [L1, 9000],
      [L2, 1000],
    ]);
  });

  it('lands return freight on the lines that actually came back', () => {
    const lines = allocate(SPLIT, amountsOf({ returnShippingCostMinor: toMinor(2000) }), [
      {
        orderItemId: L1,
        reversedQuantity: 0,
        reversedRevenueExVatMinor: ZERO,
        restockedCogsMinor: ZERO,
        impactMinor: ZERO,
      },
      {
        orderItemId: L2,
        reversedQuantity: 1,
        reversedRevenueExVatMinor: toMinor(10000),
        restockedCogsMinor: ZERO,
        impactMinor: toMinor(-10000),
      },
    ]);

    // Splitting it by revenue charges the chain the customer kept for a return
    // leg it had nothing to do with, and gives the kettlebell that caused the
    // cost a tenth of it — inside the per-SKU feature.
    expect(lines.map((l) => l.allocatedReturnShippingMinor)).toEqual([0, 2000]);
  });

  it('follows the return parcel’s own mapping when nothing was reversed', () => {
    // An RTO produces no reversal at all, so there is no returned-value weight
    // to use — but the return leg may still say which goods came back.
    const byParcel = allocate(
      SPLIT,
      amountsOf({
        returnShippingCostMinor: toMinor(2000),
        returnParcels: [parcel('S-R1', 2000, [L1])],
      }),
    );
    expect(byParcel.map((l) => l.allocatedReturnShippingMinor)).toEqual([2000, 0]);

    const unmapped = allocate(SPLIT, amountsOf({ returnShippingCostMinor: toMinor(2000) }));
    expect(unmapped.map((l) => l.allocatedReturnShippingMinor)).toEqual([1800, 200]);
  });

  it('weights a cost-only order on what the items are worth, not on its zeroed revenue', () => {
    const lines = allocateOrderCostsToLines(
      SPLIT.map(itemOf),
      SPLIT.map(unrecognizedRevenueOf),
      SPLIT.map(cogsOf),
      [],
      amountsOf({ outboundShippingCostMinor: toMinor(10000) }),
    );

    // Recognition zeroes revenue on every RTO, and an all-zero weight vector
    // makes the allocator split evenly — so a SAR 100 accessory carried the same
    // SAR 50 of courier cost as a SAR 900 item and was flagged a loss-maker at
    // 220% of its own revenue.
    expect(lines.map((l) => l.allocatedOutboundShippingMinor)).toEqual([9000, 1000]);
  });

  it('ties every allocated term back to the order total, exactly', () => {
    const skus = [sku(L1, 10000, 4000), sku(L2, 10000, 4000), sku(L3, 10000, 4000)];
    const amounts = amountsOf({
      shippingRevenueExVatMinor: toMinor(999),
      codFeeRevenueExVatMinor: toMinor(7),
      outboundShippingCostMinor: toMinor(1000),
      returnShippingCostMinor: toMinor(7),
      gatewayFeeCostMinor: toMinor(7),
      codCostMinor: toMinor(55),
    });
    const lines = allocate(skus, amounts);
    const sum = (pick: (line: (typeof lines)[number]) => number): number =>
      lines.reduce((total, line) => total + pick(line), 0);

    // If order profit and the sum of its SKU profits disagree by a halala, a
    // merchant eventually notices — and at that point every other number on the
    // page is in question.
    expect(sum((l) => l.allocatedShippingRevenueExVatMinor)).toBe(999);
    expect(sum((l) => l.allocatedCodFeeRevenueExVatMinor)).toBe(7);
    expect(sum((l) => l.allocatedOutboundShippingMinor)).toBe(1000);
    expect(sum((l) => l.allocatedReturnShippingMinor)).toBe(7);
    expect(sum((l) => l.allocatedGatewayFeeMinor)).toBe(7);
    expect(sum((l) => l.allocatedCodCostMinor)).toBe(55);

    // Seven halalas over three equal lines: the odd one goes to the lowest key,
    // never to whichever line the platform happened to return first.
    expect(lines.map((l) => l.allocatedGatewayFeeMinor)).toEqual([3, 2, 2]);
  });

  it('gives the same per-SKU figures however the lines arrived', () => {
    const skus = [sku(L1, 10000, 4000), sku(L2, 10000, 4000), sku(L3, 10000, 4000)];
    const amounts = amountsOf({ gatewayFeeCostMinor: toMinor(7) });
    const share = (ordered: readonly Sku[]): Record<string, number> =>
      Object.fromEntries(allocate(ordered, amounts).map((l) => [l.orderItemId, l.allocatedGatewayFeeMinor]));

    // Re-ingesting an order whose lines come back in a different order must not
    // churn per-SKU margins between recomputes.
    expect(share(skus)).toEqual(share([...skus].reverse()));
  });

  it('reconstructs each line’s margin from the line’s own fields', () => {
    const skus = [sku(L1, 30000, 15000), sku(L2, 10000, 5000)];
    const lines = allocate(
      skus,
      amountsOf({
        shippingRevenueExVatMinor: toMinor(2000),
        codFeeRevenueExVatMinor: toMinor(500),
        outboundShippingCostMinor: toMinor(1800),
        returnShippingCostMinor: toMinor(1500),
        gatewayFeeCostMinor: toMinor(900),
        codCostMinor: toMinor(700),
      }),
    );

    // A fixture reader must be able to rebuild the margin from the row in front
    // of them; order-level revenue reaching the line only through the margin
    // makes that impossible.
    for (const line of lines) {
      expect(line.contributionMarginMinor).toBe(
        line.netRevenueExVatMinor +
          line.allocatedShippingRevenueExVatMinor +
          line.allocatedCodFeeRevenueExVatMinor +
          line.reversalImpactMinor -
          line.cogsMinor -
          line.allocatedOutboundShippingMinor -
          line.allocatedReturnShippingMinor -
          line.allocatedGatewayFeeMinor -
          line.allocatedCodCostMinor,
      );
    }
    expect(lines.map((l) => l.contributionMarginMinor)).toEqual([13200, 4400]);
  });

  it('counts a line toward cost coverage only when its cost came from somewhere real', () => {
    const skus = [sku(L1, 30000, 15000), sku(L2, 10000, 0)];
    const uncosted: LineCogs = {
      orderItemId: L2,
      unitCostMinor: ZERO,
      cogsMinor: ZERO,
      source: 'none',
      costHistoryId: null,
      covered: false,
    };
    const lines = allocateOrderCostsToLines(
      skus.map(itemOf),
      skus.map(revenueOf),
      [cogsOf(sku(L1, 30000, 15000)), uncosted],
      [],
      amountsOf(),
    );

    // The coverage numerator. An uncosted SKU reports as the most profitable
    // product in the catalogue, so the dashboard has to be able to say how much
    // of the revenue on screen rests on a real cost.
    expect(lines.map((l) => l.costCoveredRevenueExVatMinor)).toEqual([30000, 0]);
  });

  it('returns nothing for an order with no lines to allocate to', () => {
    // The order-level amounts stay in the totals; there is nothing to tie to.
    expect(allocateOrderCostsToLines([], [], [], [], amountsOf({ gatewayFeeCostMinor: toMinor(900) }))).toEqual([]);
  });

  it('invents no identity and no cost for a revenue line with nothing behind it', () => {
    const skus = [CHAIN, KETTLEBELL];
    const phantom = sku('demo:1:1001#L9' as OrderItemId, 5000, 0);
    const lines = allocateOrderCostsToLines(
      skus.map(itemOf),
      [...skus, phantom].map(revenueOf),
      skus.map(cogsOf),
      [],
      amountsOf({ outboundShippingCostMinor: toMinor(10000) }),
    );

    // The three line arrays are parallel by construction, so a line present in
    // one and absent from the others is an engine bug rather than merchant
    // data — but the answer to one is a row that claims nothing, not a throw
    // that dead-letters the whole order.
    expect(lines).toHaveLength(3);
    expect(lines[2]?.platformProductId).toBe('');
    expect(lines[2]?.quantity).toBe(0);
    expect(lines[2]?.unitCostMinor).toBe(0);
    expect(lines[2]?.costSource).toBe('none');
    expect(lines[2]?.costHistoryId).toBeNull();
    expect(lines.reduce((total, l) => total + l.allocatedOutboundShippingMinor, 0)).toBe(10000);
  });
});

describe('a refunded delivery charge, end to end', () => {
  const FIXTURE = join(import.meta.dirname, 'fixtures', 'golden', '0002-partial-refund', 'input.json');
  const base = (): OrderProfitInput => JSON.parse(readFileSync(FIXTURE, 'utf8')) as OrderProfitInput;

  const withRefundedShipping = (): OrderProfitInput => {
    const input = base() as unknown as Record<string, unknown>;
    const revisions = (input['reversals'] as Record<string, unknown>[])[0] ?? {};
    revisions['shippingRefundExVatMinor'] = 2000;
    revisions['vatMinor'] = 4050;
    revisions['totalIncVatMinor'] = 31050;
    return input as unknown as OrderProfitInput;
  };

  it('costs the merchant exactly the refund, and marks the per-SKU split as ours', () => {
    const before = computeOrderProfit(base());
    const after = computeOrderProfit(withRefundedShipping());
    if (before.status !== 'computed' || after.status !== 'computed') throw new Error('expected both to compute');

    // The SAR 20 of delivery the merchant handed back is real money, and it
    // reaches the per-SKU view only through an allocation the engine performed.
    expect(after.totals.contributionMarginMinor - before.totals.contributionMarginMinor).toBe(-2000);
    expect(before.confidence.reversal).toBe('reported');
    expect(after.confidence.reversal).toBe('allocated');
    expect(codes(after.diagnostics)).toContain('REVERSAL_LINES_ALLOCATED');

    const sumOfLines = after.lines.reduce((total, l) => total + l.contributionMarginMinor, 0);
    expect(sumOfLines).toBe(after.totals.contributionMarginMinor);
  });
});
