import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeOrderProfit } from '../src/compute-order-profit.js';
import type { OrderProfitInput } from '../src/input.js';
import type { OrderProfitComputed, OrderProfitResult } from '../src/result.js';

const GOLDEN = join(import.meta.dirname, 'fixtures', 'golden');
const UPDATE = process.env['UPDATE_GOLDEN'] === '1';

interface Fixture {
  readonly name: string;
  readonly input: OrderProfitInput;
  readonly expected: OrderProfitResult | null;
}

function load(): readonly Fixture[] {
  const names = readdirSync(GOLDEN, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  return names.map((name) => {
    // One documented cast per harness. `JSON.parse` cannot produce branded
    // types, and a fixture that had to construct them through the checked
    // constructors would stop being plain JSON — which is the whole point of
    // golden fixtures.
    const input = JSON.parse(readFileSync(join(GOLDEN, name, 'input.json'), 'utf8')) as OrderProfitInput;
    // Absent on the very first run, when UPDATE_GOLDEN writes them.
    let expected: OrderProfitResult | null;
    try {
      expected = JSON.parse(readFileSync(join(GOLDEN, name, 'expected.json'), 'utf8')) as OrderProfitResult;
    } catch {
      expected = null;
    }
    return { name, input, expected };
  });
}

const fixtures = load();

const sum = (values: readonly number[]): number => values.reduce((a, b) => a + b, 0);

/** Every money field the result carries, so a stray float or overflow is caught anywhere. */
function moneyFields(result: OrderProfitComputed): readonly number[] {
  const { totals } = result;
  return [
    ...Object.values(totals).filter((v): v is number => typeof v === 'number'),
    ...result.lines.flatMap((line) => Object.values(line).filter((v): v is number => typeof v === 'number')),
  ];
}

describe('golden fixtures', () => {
  it('found fixtures at all', () => {
    // A misspelled path would otherwise pass zero cases, silently.
    expect(fixtures.length).toBeGreaterThanOrEqual(11);
  });

  it.each(fixtures.map((f) => [f.name, f] as const))('%s matches its recorded expectation', (_name, fixture) => {
    const actual = computeOrderProfit(fixture.input);

    if (UPDATE) {
      writeFileSync(join(GOLDEN, fixture.name, 'expected.json'), `${JSON.stringify(actual, null, 2)}\n`);
      return;
    }

    expect(fixture.expected).not.toBeNull();
    // toStrictEqual, not toEqual: it catches an `undefined` where a field should
    // be absent, which is exactly the confidence bug we would otherwise ship.
    expect(actual).toStrictEqual(fixture.expected);
  });

  /**
   * These are checked independently of the recorded expectations. A regenerated
   * `expected.json` can only ever agree with the implementation; these say what
   * must be true of ANY implementation.
   */
  it.each(fixtures.map((f) => [f.name, f] as const))('%s satisfies the engine invariants', (_name, fixture) => {
    const result = computeOrderProfit(fixture.input);
    if (result.status === 'rejected') {
      expect(result.diagnostics.some((d) => d.severity === 'fatal')).toBe(true);
      return;
    }

    const t = result.totals;

    expect(t.revenueExVatMinor).toBe(
      t.itemsRevenueExVatMinor + t.shippingRevenueExVatMinor + t.codFeeRevenueExVatMinor - t.orderDiscountExVatMinor,
    );

    expect(t.contributionMarginMinor).toBe(
      t.revenueExVatMinor -
        t.cogsMinor -
        t.outboundShippingCostMinor -
        t.returnShippingCostMinor -
        t.gatewayFeeCostMinor -
        t.codCostMinor +
        t.reversalImpactMinor,
    );

    expect(t.gatewayFeeCostMinor).toBe(
      fixture.input.store.vatRegistered ? t.gatewayFeeExVatMinor : t.gatewayFeeExVatMinor + t.gatewayFeeVatMinor,
    );
    expect(t.codCostMinor).toBe(
      fixture.input.store.vatRegistered ? t.codCostExVatMinor : t.codCostExVatMinor + t.codCostVatMinor,
    );
    expect(t.reversalImpactMinor).toBe(t.restockedCogsMinor - t.reversedRevenueExVatMinor);

    // You cannot get back more goods than you shipped. Without this, a reversal
    // with no line detail credited the WHOLE order's COGS regardless of how
    // little was refunded, and a refund could raise profit.
    expect(t.restockedCogsMinor).toBeLessThanOrEqual(t.cogsMinor);

    if (result.lines.length > 0) {
      // The tie that matters most: if order profit and the sum of its SKU
      // profits disagree by a halala, every other number on the page is in
      // question.
      expect(sum(result.lines.map((l) => l.contributionMarginMinor))).toBe(t.contributionMarginMinor);
      expect(sum(result.lines.map((l) => l.cogsMinor))).toBe(t.cogsMinor);
      expect(sum(result.lines.map((l) => l.allocatedOutboundShippingMinor))).toBe(t.outboundShippingCostMinor);
      expect(sum(result.lines.map((l) => l.allocatedReturnShippingMinor))).toBe(t.returnShippingCostMinor);
      expect(sum(result.lines.map((l) => l.allocatedGatewayFeeMinor))).toBe(t.gatewayFeeCostMinor);
      expect(sum(result.lines.map((l) => l.allocatedCodCostMinor))).toBe(t.codCostMinor);
      expect(sum(result.lines.map((l) => l.reversalImpactMinor))).toBe(t.reversalImpactMinor);
      expect(sum(result.lines.map((l) => l.costCoveredRevenueExVatMinor))).toBe(t.costCoveredRevenueExVatMinor);

      // The REVENUE side of the tie. Shipping and COD-fee revenue were the only
      // order-level terms with no assertion, which is exactly where the engine
      // silently disagreed with itself by the value of a free-shipping coupon.
      expect(
        sum(result.lines.map((l) => l.netRevenueExVatMinor)) +
          sum(result.lines.map((l) => l.allocatedShippingRevenueExVatMinor)) +
          sum(result.lines.map((l) => l.allocatedCodFeeRevenueExVatMinor)),
      ).toBe(t.revenueExVatMinor);

      for (const line of result.lines) {
        expect(line.restockedCogsMinor).toBeLessThanOrEqual(line.cogsMinor);
        expect(line.contributionMarginMinor).toBe(
          line.netRevenueExVatMinor +
            line.allocatedShippingRevenueExVatMinor +
            line.allocatedCodFeeRevenueExVatMinor -
            line.cogsMinor -
            line.allocatedOutboundShippingMinor -
            line.allocatedReturnShippingMinor -
            line.allocatedGatewayFeeMinor -
            line.allocatedCodCostMinor +
            line.reversalImpactMinor,
        );
      }
    }

    for (const value of moneyFields(result)) {
      expect(Number.isSafeInteger(value)).toBe(true);
      expect(Object.is(value, -0)).toBe(false);
    }

    // `level` is a pure projection, so it cannot disagree with the terms.
    const bases = [
      result.confidence.cogs,
      result.confidence.outboundShipping,
      result.confidence.returnShipping,
      result.confidence.gatewayFee,
      result.confidence.codCost,
    ];
    if (bases.includes('missing') || result.confidence.revenue === 'unreconciled') {
      expect(result.confidence.level).toBe('incomplete');
    }
    if (result.confidence.level === 'exact') {
      expect(bases.every((b) => b === 'actual' || b === 'not_applicable')).toBe(true);
      expect(result.confidence.revenue).toBe('reported');
    }

    // Deterministic: same input, same answer, forever.
    expect(computeOrderProfit(fixture.input)).toStrictEqual(result);
  });

  it('is invariant to the order items and shipments arrive in', () => {
    for (const fixture of fixtures) {
      const shuffled: OrderProfitInput = {
        ...fixture.input,
        items: [...fixture.input.items].reverse(),
        shipments: [...fixture.input.shipments].reverse(),
        costs: [...fixture.input.costs].reverse(),
      };
      expect(computeOrderProfit(shuffled)).toStrictEqual(computeOrderProfit(fixture.input));
    }
  });
});
