import { describe, expect, it } from 'vitest';
import { toInstant, toMinor } from '@ghalla/contracts';
import type { CanonicalReversal, OrderItemId } from '@ghalla/contracts';
import { computeReversalImpact } from '../src/engine/reversal.js';
import type { LineCogs } from '../src/engine/cogs.js';
import type { LineRevenue } from '../src/engine/revenue.js';

/**
 * The redistribution pass added in CALC_VERSION 3.
 *
 * A restock credit is spread by line REVENUE and then capped at each line's own
 * cost — a line can only ever return the cost of the goods on it. Discarding
 * the overflow was the bug: on a mixed-margin order the revenue split and the
 * cost split disagree, so a full refund returned only a fraction of the stock
 * the merchant is demonstrably holding again.
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

const run = (
  lines: { readonly n: number; readonly gross: number; readonly cogs: number }[],
  rev: CanonicalReversal,
): ReturnType<typeof computeReversalImpact> => {
  const revenueLines = lines.map((l) => revenueLine(l.n, l.gross));
  const cogsLines = lines.map((l) => cogsLine(l.n, l.cogs));
  const quantities = new Map(lines.map((l) => [id(l.n), 1]));
  const weights = new Map(lines.map((l) => [id(l.n), toMinor(l.gross)]));
  return computeReversalImpact(
    [rev],
    revenueLines,
    cogsLines,
    quantities,
    weights,
    { kind: 'recognized' },
    [],
    true,
  );
};

describe('a restock credit a line cannot absorb', () => {
  it('falls to the lines that can, rather than being discarded at the cap', () => {
    // A cheap-to-make item priced high and an expensive one priced low. Revenue
    // share sends most of the credit to the first, whose own cost is SAR 10 —
    // and the SAR 70 it cannot hold belongs to the second, which is holding
    // SAR 80 of stock back on the shelf.
    const result = run(
      [
        { n: 1, gross: 30_000, cogs: 1_000 },
        { n: 2, gross: 10_000, cogs: 8_000 },
      ],
      reversal({ amountExVatMinor: toMinor(40_000), totalIncVatMinor: toMinor(40_000) }),
    );

    // The whole order came back, so the whole order's cost returns.
    expect(result.value.restockedCogsMinor).toBe(9_000);
    const byLine = new Map(result.value.lines.map((l) => [l.orderItemId, l.restockedCogsMinor]));
    expect(byLine.get(id(1))).toBe(1_000);
    expect(byLine.get(id(2))).toBe(8_000);
  });

  it('never credits a line more than the goods on it cost', () => {
    // The cap itself still holds: a partial refund cannot return stock that was
    // never sold.
    const result = run(
      [
        { n: 1, gross: 30_000, cogs: 1_000 },
        { n: 2, gross: 10_000, cogs: 8_000 },
      ],
      reversal({ amountExVatMinor: toMinor(20_000), totalIncVatMinor: toMinor(20_000) }),
    );
    for (const line of result.value.lines) {
      const cost = line.orderItemId === id(1) ? 1_000 : 8_000;
      expect(line.restockedCogsMinor).toBeLessThanOrEqual(cost);
    }
    // Half the order's value refunded, and the credit is bounded by what the
    // lines can actually absorb rather than by the revenue split alone.
    expect(result.value.restockedCogsMinor).toBeLessThanOrEqual(9_000);
    expect(result.value.restockedCogsMinor).toBeGreaterThan(0);
  });

  it('stops rather than looping when no line has any cost to return', () => {
    // Every line uncosted: there is nothing to credit and nothing to
    // redistribute, and the pass must terminate on the first round.
    const result = run(
      [
        { n: 1, gross: 30_000, cogs: 0 },
        { n: 2, gross: 10_000, cogs: 0 },
      ],
      reversal({ amountExVatMinor: toMinor(40_000), totalIncVatMinor: toMinor(40_000) }),
    );
    expect(result.value.restockedCogsMinor).toBe(0);
  });

  it('places a credit too small to reach every line without looping', () => {
    // Three lines costing one halala each, and a third of the order refunded:
    // the prorated credit is a single halala. Largest remainder gives it to one
    // line and nothing to the other two, which is the case where a share of
    // zero meets a line that still has headroom.
    const result = run(
      [
        { n: 1, gross: 10_000, cogs: 1 },
        { n: 2, gross: 10_000, cogs: 1 },
        { n: 3, gross: 10_000, cogs: 1 },
      ],
      reversal({ amountExVatMinor: toMinor(10_000), totalIncVatMinor: toMinor(10_000) }),
    );
    expect(result.value.restockedCogsMinor).toBe(1);
    expect(result.value.lines.filter((l) => l.restockedCogsMinor === 1)).toHaveLength(1);
  });

  it('credits nothing when the refund returned no goods at all', () => {
    // A shipping-only or goodwill refund moves money and no stock. Crediting
    // COGS there is how a refund came to raise profit.
    const result = run(
      [{ n: 1, gross: 30_000, cogs: 12_000 }],
      reversal({
        amountExVatMinor: toMinor(0),
        shippingRefundExVatMinor: toMinor(2_000),
        totalIncVatMinor: toMinor(2_000),
      }),
    );
    expect(result.value.restockedCogsMinor).toBe(0);
  });
});

describe('a second refund on stock that already came back', () => {
  it('stops rather than crediting the same goods twice', () => {
    // A merchant refunds an order in two parts — a partial, then the rest. The
    // cost of the goods can only come back ONCE, so by the second reversal the
    // line has no headroom left. The redistribution loop must notice that
    // nothing landed and stop, instead of spinning on a residue it can never
    // place.
    const revenueLines = [revenueLine(1, 40_000)];
    const cogsLines = [cogsLine(1, 9_000)];
    const quantities = new Map([[id(1), 1]]);
    const weights = new Map([[id(1), toMinor(40_000)]]);

    const result = computeReversalImpact(
      [
        reversal({
          id: 'o#rev:1' as CanonicalReversal['id'],
          amountExVatMinor: toMinor(40_000),
          totalIncVatMinor: toMinor(40_000),
        }),
        reversal({
          id: 'o#rev:2' as CanonicalReversal['id'],
          platformReversalId: 'r2',
          amountExVatMinor: toMinor(40_000),
          totalIncVatMinor: toMinor(40_000),
        }),
      ],
      revenueLines,
      cogsLines,
      quantities,
      weights,
      { kind: 'recognized' },
      [],
      true,
    );

    // The whole cost, once — not twice, which would turn a double refund into
    // a profit.
    expect(result.value.restockedCogsMinor).toBe(9_000);
  });
});

describe('a reversal whose line detail disagrees with its own total', () => {
  it('spreads the shortfall rather than keeping the smaller figure', () => {
    // The reversal's own amount ties to the cash; the lines are the detail.
    // Keeping whichever was smaller lost refunded money whenever the detail
    // summed low, and kept it whenever the detail summed high — so the
    // direction of the error was decided by the direction of the discrepancy.
    const result = run(
      [
        { n: 1, gross: 10_000, cogs: 4_000 },
        { n: 2, gross: 30_000, cogs: 12_000 },
      ],
      reversal({
        amountExVatMinor: toMinor(30_000),
        totalIncVatMinor: toMinor(30_000),
        lines: [
          { orderItemId: id(2), quantity: 1, amountExVatMinor: toMinor(25_000), restockOutcome: 'not_restocked' },
        ],
      }),
    );

    expect(result.value.reversedRevenueExVatMinor).toBe(30_000);
    expect(result.diagnostics.map((d) => d.code)).toContain('REVERSAL_TOTAL_MISMATCH');
    // Our arithmetic, not the platform's, so it must say so.
    expect(result.value.allocated).toBe(true);
  });
});
