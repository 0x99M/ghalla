import { describe, expect, it } from 'vitest';
import { toInstant, toMinor } from '@ghalla/contracts';
import type { CanonicalReversal, CanonicalShipment, Minor, OrderItemId } from '@ghalla/contracts';
import { computeReversalImpact } from '../src/engine/reversal.js';
import type { LineCogs } from '../src/engine/cogs.js';
import type { LineRevenue } from '../src/engine/revenue.js';

/**
 * A line the rest of the order knows nothing about.
 *
 * `computeReversalImpact` takes the revenue lines, the cost lines, the
 * quantities and the weights as four SEPARATE arguments, and nothing in the
 * type system says they cover the same set of items. In practice they diverge
 * constantly:
 *
 *   - an uncosted SKU has a revenue line and no cost line, which is the whole
 *     point of the coverage indicator;
 *   - a fully discounted item has a revenue line and a weight of zero;
 *   - a line the adapter could not match to a product has no quantity.
 *
 * Every map lookup in that function therefore carries a fallback, and those
 * fallbacks are the arithmetic for exactly these orders. Testing them is not
 * defensive-code theatre: the alternative to `?? 0` firing correctly is
 * `undefined` propagating into a subtraction and a merchant's dashboard showing
 * NaN, or worse, `null` reaching a money column.
 */
const id = (n: number): OrderItemId => `o#L${String(n)}` as OrderItemId;

const revenueLine = (n: number, gross: number): LineRevenue => ({
  orderItemId: id(n),
  grossExVatMinor: toMinor(gross),
  allocatedOrderDiscountExVatMinor: toMinor(0),
  netExVatMinor: toMinor(gross),
});

const cogsLine = (n: number, cogs: number): LineCogs => ({
  orderItemId: id(n),
  unitCostMinor: toMinor(cogs),
  cogsMinor: toMinor(cogs),
  source: 'merchant_manual',
  costHistoryId: 'ch' as LineCogs['costHistoryId'],
  covered: true,
});

const reversal = (over: Partial<CanonicalReversal>): CanonicalReversal =>
  ({
    id: 'o#rev:1',
    orderId: 'o',
    platformReversalId: 'r1',
    kind: 'refund',
    reason: 'customer_return',
    rawReasonLabel: null,
    occurredAt: toInstant('2026-03-10T00:00:00.000Z'),
    amountExVatMinor: toMinor(0),
    shippingRefundExVatMinor: toMinor(0),
    codFeeRefundExVatMinor: toMinor(0),
    adjustmentExVatMinor: toMinor(0),
    vatMinor: toMinor(0),
    totalIncVatMinor: toMinor(0),
    lines: null,
    restockOutcome: 'restocked_sellable',
    platformUpdatedAt: null,
    ...over,
  }) as CanonicalReversal;

/** Two revenue lines; only the FIRST appears in the cost, quantity and weight maps. */
const partial = (
  rev: CanonicalReversal,
  recognition: Parameters<typeof computeReversalImpact>[5] = { kind: 'recognized' },
  shipments: readonly CanonicalShipment[] = [],
  dispatched = true,
): ReturnType<typeof computeReversalImpact> =>
  computeReversalImpact(
    [rev],
    [revenueLine(1, 30_000), revenueLine(2, 10_000)],
    [cogsLine(1, 12_000)],
    new Map([[id(1), 1]]),
    new Map<OrderItemId, Minor>([[id(1), toMinor(30_000)]]),
    recognition,
    shipments,
    dispatched,
  );

describe('a reversal on an order whose lines are only partly known', () => {
  it('credits the costed line and leaves the uncosted one at zero', () => {
    // The uncosted line has no cost to return, so it must contribute nothing —
    // not `undefined`, and not the other line's cost.
    const result = partial(
      reversal({ amountExVatMinor: toMinor(40_000), totalIncVatMinor: toMinor(40_000) }),
    );

    const byLine = new Map(result.value.lines.map((l) => [l.orderItemId, l]));
    expect(byLine.get(id(1))?.restockedCogsMinor).toBe(12_000);
    expect(byLine.get(id(2))?.restockedCogsMinor).toBe(0);
    expect(result.value.restockedCogsMinor).toBe(12_000);
  });

  it('gives the whole reversal to the line that carries all the weight', () => {
    // The second line has no weight, so the revenue split sends it nothing.
    // A missing weight must read as zero share, never as an equal share.
    const result = partial(
      reversal({ amountExVatMinor: toMinor(40_000), totalIncVatMinor: toMinor(40_000) }),
    );
    const byLine = new Map(result.value.lines.map((l) => [l.orderItemId, l]));
    expect(byLine.get(id(1))?.reversedRevenueExVatMinor).toBe(40_000);
    expect(byLine.get(id(2))?.reversedRevenueExVatMinor).toBe(0);
  });

  it('reports a quantity of zero for a line it has no ordered count for', () => {
    // `reversedQuantity` is capped by what was ordered. With no ordered count
    // the cap is zero, which is the honest answer: we cannot say a line came
    // back if we never knew how many went out.
    const result = partial(
      reversal({
        amountExVatMinor: toMinor(40_000),
        totalIncVatMinor: toMinor(40_000),
        lines: [
          { orderItemId: id(1), quantity: 1, amountExVatMinor: toMinor(30_000), restockOutcome: 'restocked_sellable' },
          { orderItemId: id(2), quantity: 1, amountExVatMinor: toMinor(10_000), restockOutcome: 'restocked_sellable' },
        ],
      }),
    );
    const byLine = new Map(result.value.lines.map((l) => [l.orderItemId, l]));
    expect(byLine.get(id(1))?.reversedQuantity).toBe(1);
    expect(byLine.get(id(2))?.reversedQuantity).toBe(0);
    // And crediting cost follows the same clamp, so the unknown line returns
    // nothing rather than a unit cost it does not have.
    expect(byLine.get(id(2))?.restockedCogsMinor).toBe(0);
  });

  it('keeps every field a finite number, whatever is missing', () => {
    // The failure this guards is `undefined` reaching a subtraction: NaN on a
    // dashboard, or null in a money column.
    const result = partial(
      reversal({
        amountExVatMinor: toMinor(20_000),
        shippingRefundExVatMinor: toMinor(1_500),
        totalIncVatMinor: toMinor(21_500),
        lines: [
          { orderItemId: id(2), quantity: 3, amountExVatMinor: toMinor(20_000), restockOutcome: 'restocked_sellable' },
        ],
      }),
    );
    for (const line of result.value.lines) {
      expect(Number.isSafeInteger(line.reversedRevenueExVatMinor)).toBe(true);
      expect(Number.isSafeInteger(line.restockedCogsMinor)).toBe(true);
      expect(Number.isSafeInteger(line.impactMinor)).toBe(true);
      expect(Number.isSafeInteger(line.reversedQuantity)).toBe(true);
    }
    expect(Number.isSafeInteger(result.value.impactMinor)).toBe(true);
  });
});

describe('recovering the whole order when nothing was dispatched', () => {
  it('returns only the cost it knows about, and no quantity it does not', () => {
    // `creditWholeOrder` reads the cost and quantity maps directly. An order
    // cancelled after capture with one uncosted line must return that line as
    // zero rather than as undefined — this is the path a cancelled order takes,
    // so it is not a rare one.
    const result = partial(
      reversal({ amountExVatMinor: toMinor(0), totalIncVatMinor: toMinor(0) }),
      { kind: 'cost_only', reason: 'cancelled_after_capture' },
      [],
      false,
    );

    const byLine = new Map(result.value.lines.map((l) => [l.orderItemId, l]));
    expect(byLine.get(id(1))?.restockedCogsMinor).toBe(12_000);
    expect(byLine.get(id(1))?.reversedQuantity).toBe(1);
    expect(byLine.get(id(2))?.restockedCogsMinor).toBe(0);
    expect(byLine.get(id(2))?.reversedQuantity).toBe(0);
    expect(result.value.inferredRestock).toBe(true);
    // Nothing was sold, so nothing is reversed — only cost comes back.
    expect(result.value.reversedRevenueExVatMinor).toBe(0);
  });
});

describe('the redistribution pass on a partly costed order', () => {
  it('stops once every costed line is full, leaving the uncosted one alone', () => {
    // The overflow loop only ever considers lines with a cost. With one costed
    // line and one without, the second round has nowhere left to put the
    // residue and must terminate rather than spin.
    const result = partial(
      reversal({ amountExVatMinor: toMinor(40_000), totalIncVatMinor: toMinor(40_000) }),
    );
    expect(result.value.restockedCogsMinor).toBe(12_000);
    const byLine = new Map(result.value.lines.map((l) => [l.orderItemId, l]));
    expect(byLine.get(id(2))?.restockedCogsMinor).toBe(0);
  });

  it('returns nothing at all when no line on the order has a cost', () => {
    const result = computeReversalImpact(
      [reversal({ amountExVatMinor: toMinor(40_000), totalIncVatMinor: toMinor(40_000) })],
      [revenueLine(1, 30_000), revenueLine(2, 10_000)],
      [],
      new Map(),
      new Map(),
      { kind: 'recognized' },
      [],
      true,
    );
    expect(result.value.restockedCogsMinor).toBe(0);
    // No weights at all means no bucket carries any share, so the revenue
    // reversal has nowhere to land either — and must not become NaN.
    for (const line of result.value.lines) {
      expect(Number.isSafeInteger(line.reversedRevenueExVatMinor)).toBe(true);
    }
  });
});
