import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { computeOrderProfit } from '../src/compute-order-profit.js';
import type { OrderProfitInput } from '../src/input.js';

const BASE = JSON.parse(
  readFileSync(join(import.meta.dirname, 'fixtures', 'golden', '0006-prepaid-card-baseline', 'input.json'), 'utf8'),
) as OrderProfitInput;

const clone = (): OrderProfitInput => JSON.parse(JSON.stringify(BASE)) as OrderProfitInput;
const mutate = (fn: (input: Record<string, unknown>) => void): OrderProfitInput => {
  const input = clone() as unknown as Record<string, unknown>;
  fn(input);
  return input as unknown as OrderProfitInput;
};

/**
 * `computeOrderProfit` promises it never throws, for any input. In a queue
 * worker a thrown exception is indistinguishable from a transient failure and
 * gets retried forever, so the promise has to hold for inputs no TypeScript
 * caller could produce — the layer that will hand it a truncated payload is
 * ingestion, which does not exist yet and will not be type-checked against it.
 */
describe('totality', () => {
  const hostile: readonly [string, unknown][] = [
    ['null', null],
    ['undefined', undefined],
    ['empty object', {}],
    ['null order', mutate((i) => { i['order'] = null; })],
    ['missing order', mutate((i) => { delete i['order']; })],
    ['null store', mutate((i) => { i['store'] = null; })],
    ['missing store', mutate((i) => { delete i['store']; })],
    ['missing feeRuleSet', mutate((i) => { delete i['feeRuleSet']; })],
    ['missing items', mutate((i) => { delete i['items']; })],
    ['missing shipments', mutate((i) => { delete i['shipments']; })],
    ['missing costs', mutate((i) => { delete i['costs']; })],
    ['a string where money belongs', mutate((i) => {
      (i['order'] as Record<string, unknown>)['subtotalExVatMinor'] = '60000';
    })],
    ['NaN money', mutate((i) => {
      (i['order'] as Record<string, unknown>)['totalIncVatMinor'] = Number.NaN;
    })],
    ['Infinity money', mutate((i) => {
      (i['order'] as Record<string, unknown>)['vatAmountMinor'] = Number.POSITIVE_INFINITY;
    })],
    ['a fractional quantity', mutate((i) => {
      ((i['items'] as Record<string, unknown>[])[0] ?? {})['quantity'] = 2.5;
    })],
    ['an absurd quantity', mutate((i) => {
      ((i['items'] as Record<string, unknown>[])[0] ?? {})['quantity'] = 1e308;
    })],
    ['duplicate item ids', mutate((i) => {
      const items = i['items'] as Record<string, unknown>[];
      i['items'] = [items[0], { ...items[0] }];
    })],
    ['a missing timezone', mutate((i) => {
      delete (i['store'] as Record<string, unknown>)['timezone'];
    })],
    ['an unknown timezone', mutate((i) => {
      (i['store'] as Record<string, unknown>)['timezone'] = 'Mars/Olympus';
    })],
    ['a calendar date that does not exist', mutate((i) => {
      (i['order'] as Record<string, unknown>)['placedAt'] = '2026-02-30T00:00:00.000Z';
    })],
    ['a timestamp without milliseconds', mutate((i) => {
      (i['order'] as Record<string, unknown>)['placedAt'] = '2026-03-01T18:30:00Z';
    })],
    ['a fractional rate — 2.75 meaning 2.75%', mutate((i) => {
      ((i['feeRuleSet'] as Record<string, unknown>)['gateway'] as Record<string, unknown>[]).forEach((r) => {
        r['percentBps'] = 2.75;
      });
    })],
    ['a transposed fee floor and cap', mutate((i) => {
      const rule = ((i['feeRuleSet'] as Record<string, unknown>)['gateway'] as Record<string, unknown>[])[0] ?? {};
      rule['minFeeMinor'] = 20_000;
      rule['maxFeeMinor'] = 100;
    })],
    ['a negative percentage', mutate((i) => {
      (((i['feeRuleSet'] as Record<string, unknown>)['gateway'] as Record<string, unknown>[])[0] ?? {})['percentBps'] = -275;
    })],
    ['duplicate gateway rules', mutate((i) => {
      const rules = (i['feeRuleSet'] as Record<string, unknown>)['gateway'] as Record<string, unknown>[];
      (i['feeRuleSet'] as Record<string, unknown>)['gateway'] = [...rules, { ...rules[0] }];
    })],
    ['an empty order with a large discount', mutate((i) => {
      i['items'] = [];
      (i['order'] as Record<string, unknown>)['discounts'] = [
        { code: null, target: 'items', reflectedInComponent: false, amountExVatMinor: 50_000 },
      ];
    })],
    ['a reversal for a different order', mutate((i) => {
      i['reversals'] = [{ id: 'x', orderId: 'other', kind: 'refund', reason: 'other', rawReasonLabel: null,
        occurredAt: '2026-03-01T00:00:00.000Z', amountExVatMinor: 0, shippingRefundExVatMinor: 0,
        codFeeRefundExVatMinor: 0, adjustmentExVatMinor: 0, vatMinor: 0, totalIncVatMinor: 0,
        lines: null, restockOutcome: 'unknown', platformUpdatedAt: null, platformReversalId: null }];
    })],
  ];

  it.each(hostile)('does not throw on %s', (_label, input) => {
    expect(() => computeOrderProfit(input as OrderProfitInput)).not.toThrow();
  });

  it.each(hostile)('rejects %s with a fatal diagnostic rather than a plausible number', (_label, input) => {
    const result = computeOrderProfit(input as OrderProfitInput);
    if (result.status === 'rejected') {
      expect(result.diagnostics.some((d) => d.severity === 'fatal')).toBe(true);
      expect(result.diagnostics.length).toBeGreaterThan(0);
    }
  });

  it('names the right thing: a bad timestamp is not a bad timezone', () => {
    const badDate = mutate((i) => {
      (i['order'] as Record<string, unknown>)['placedAt'] = '2026-02-30T00:00:00.000Z';
    });
    const result = computeOrderProfit(badDate);
    expect(result.status).toBe('rejected');
    expect(result.diagnostics.map((d) => d.code)).toContain('MALFORMED_TIMESTAMP');
    expect(result.diagnostics.map((d) => d.code)).not.toContain('INVALID_TIMEZONE');
  });

  it('names the right thing: a fractional quantity is not a negative one', () => {
    const fractional = mutate((i) => {
      ((i['items'] as Record<string, unknown>[])[0] ?? {})['quantity'] = 2.5;
    });
    const codes = computeOrderProfit(fractional).diagnostics.map((d) => d.code);
    expect(codes).toContain('NON_INTEGER_QUANTITY');
    expect(codes).not.toContain('NEGATIVE_QUANTITY');
  });

  it('blames the rate card, not the engine, for a bad rate card', () => {
    const fractionalRate = mutate((i) => {
      ((i['feeRuleSet'] as Record<string, unknown>)['gateway'] as Record<string, unknown>[]).forEach((r) => {
        r['percentBps'] = 2.75;
      });
    });
    const codes = computeOrderProfit(fractionalRate).diagnostics.map((d) => d.code);
    expect(codes).toContain('FEE_RULE_INVALID');
    expect(codes).not.toContain('INTERNAL_INVARIANT_VIOLATED');
  });

  it('does not mutate its input', () => {
    const input = clone();
    const before = JSON.stringify(input);
    computeOrderProfit(input);
    expect(JSON.stringify(input)).toBe(before);
  });

  it('is unaffected by the host timezone', () => {
    // The engine takes the store's zone explicitly; the ambient one must not reach it.
    const previous = process.env['TZ'];
    try {
      process.env['TZ'] = 'Pacific/Kiritimati';
      const a = computeOrderProfit(clone());
      process.env['TZ'] = 'America/New_York';
      const b = computeOrderProfit(clone());
      expect(a).toStrictEqual(b);
    } finally {
      if (previous === undefined) delete process.env['TZ'];
      else process.env['TZ'] = previous;
    }
  });
});
