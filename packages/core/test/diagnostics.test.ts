import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MAX_MINOR } from '@ghalla/contracts';
import { DIAGNOSTIC_CODES } from '../src/diagnostics.js';
import type { DiagnosticCode } from '../src/diagnostics.js';
import { severityOf } from '../src/engine/diagnostics-builder.js';
import { computeOrderProfit } from '../src/compute-order-profit.js';
import type { OrderProfitInput } from '../src/input.js';

/**
 * The diagnostic vocabulary, and the last diagnostic the engine has left.
 *
 * `DIAGNOSTIC_CODES` is not telemetry: each member is a translation key for the
 * Arabic dashboard, and its severity decides whether an order is dead-lettered
 * or merely shown with lower confidence. Both are merchant-facing consequences
 * of a list that no type checker can keep honest on its own.
 */

const BASE = JSON.parse(
  readFileSync(join(import.meta.dirname, 'fixtures', 'golden', '0006-prepaid-card-baseline', 'input.json'), 'utf8'),
) as unknown;

type Bag = Record<string, unknown>;

/** The same documented cast the other engine suites carry: JSON cannot produce branded types. */
function withInput(mutate: (input: Bag) => void): OrderProfitInput {
  const input = JSON.parse(JSON.stringify(BASE)) as Bag;
  mutate(input);
  return input as unknown as OrderProfitInput;
}

/**
 * Every code the engine may raise, split by what a merchant is meant to do
 * about it. Written out rather than derived, because deriving it from the
 * source would agree with any mistake the source makes.
 */
const FATAL: readonly DiagnosticCode[] = [
  'CURRENCY_MISMATCH',
  'ITEM_ORDER_ID_MISMATCH',
  'REVERSAL_ORDER_ID_MISMATCH',
  'NON_INTEGER_MINOR_UNITS',
  'NEGATIVE_QUANTITY',
  'NON_INTEGER_QUANTITY',
  'DUPLICATE_ITEM_ID',
  'DUPLICATE_RULE_KEY',
  'DUPLICATE_COST_KEY',
  'FEE_RULE_INVALID',
  'MALFORMED_INPUT',
  'MALFORMED_TIMESTAMP',
  'INVALID_TIMEZONE',
  'INTERNAL_INVARIANT_VIOLATED',
];

describe('the diagnostic vocabulary', () => {
  it('names every code exactly once', () => {
    // A duplicate is invisible to the union type and to the compiler, and would
    // only ever be a merge accident — but it makes the list stop being a
    // reliable enumeration of what the dashboard has to translate.
    expect(new Set(DIAGNOSTIC_CODES).size).toBe(DIAGNOSTIC_CODES.length);
  });

  it('keeps every code in the shape a translation key has to take', () => {
    // These are looked up, not printed. A code carrying a space, a lowercase
    // letter or punctuation is a key that silently resolves to nothing, leaving
    // a merchant with a blank explanation beside a number they distrust.
    for (const code of DIAGNOSTIC_CODES) {
      expect(code).toMatch(/^[A-Z][A-Z0-9]*(_[A-Z0-9]+)*$/);
    }
  });

  it('holds the fatal codes to exactly the caller and ingestion defects', () => {
    // Severity is the dead-letter switch. A fatal misfiled as a warning lets a
    // broken order produce numbers a merchant will act on; a warning misfiled as
    // fatal throws away an order that had a perfectly good margin in it.
    const fatal = DIAGNOSTIC_CODES.filter((code) => severityOf(code) === 'fatal');
    expect([...fatal].sort()).toStrictEqual([...FATAL].sort());
  });

  it('treats everything else as a warning the result survives', () => {
    const warnings = DIAGNOSTIC_CODES.filter((code) => severityOf(code) === 'warning');
    // The activation loop lives in this half: COST_MISSING is the call to action
    // that gets a merchant to enter a cost, so it must never dead-letter.
    expect(warnings).toContain('COST_MISSING');
    expect(warnings).toContain('SHIPPING_FALLBACK_MISSING');
    expect(warnings).toContain('RESTOCK_UNKNOWN');
    expect(warnings.length + FATAL.length).toBe(DIAGNOSTIC_CODES.length);
  });

  it('keeps a code for every escape the engine needs from a fact it does not have', () => {
    // Each of these exists so a term can be reported as unknown rather than
    // guessed at zero. Losing one would not fail to compile; it would just make
    // the engine quietly confident about a number it invented.
    for (const code of [
      'COST_MISSING',
      'CARRIER_COST_MISSING',
      'SHIPPING_FALLBACK_MISSING',
      'FEE_RULE_MISSING',
      'COD_FEE_RULE_MISSING',
      'UNKNOWN_PAYMENT_INSTRUMENT',
      'CARD_SCHEME_UNKNOWN',
      'RESTOCK_UNKNOWN',
    ] as const) {
      expect(DIAGNOSTIC_CODES).toContain(code);
    }
  });
});

describe('the last resort when an internal invariant fails', () => {
  /**
   * Two line totals that are each individually representable but sum past the
   * money range. `normalizeAndValidate` checks each field against MAX_MINOR
   * one at a time, so this is the shape that gets past validation and then
   * fails inside the arithmetic.
   */
  const overflowing = (): OrderProfitInput =>
    withInput((input) => {
      const items = input['items'] as Bag[];
      const first = items[0] as Bag;
      input['items'] = [
        { ...first, lineTotalExVatMinor: MAX_MINOR, grossLineExVatMinor: MAX_MINOR },
        {
          ...first,
          id: `${String(first['id'])}b`,
          platformLineId: 'L2',
          lineTotalExVatMinor: MAX_MINOR,
          grossLineExVatMinor: MAX_MINOR,
        },
      ];
    });

  it('rejects rather than throws when the money kernel refuses a sum', () => {
    // Totality is the promise a queue worker depends on: a thrown exception is
    // indistinguishable from a transient failure and gets retried forever, so
    // an engine bug has to come back as a dead letter instead.
    const result = computeOrderProfit(overflowing());
    expect(result.status).toBe('rejected');
    expect(result.diagnostics.map((d) => d.code)).toStrictEqual(['INTERNAL_INVARIANT_VIOLATED']);
  });

  it('blames the engine rather than the merchant’s data', () => {
    // The two amounts are each legal money. Nothing the merchant typed is wrong,
    // so naming a data fatal would send them to a screen with nothing to fix.
    const result = computeOrderProfit(overflowing());
    expect(result.diagnostics[0]?.severity).toBe('fatal');
    expect(result.diagnostics[0]?.subject).toStrictEqual({ kind: 'order' });
  });

  it('still identifies the order it gave up on', () => {
    // A dead letter nobody can trace back to an order is a dead letter nobody
    // can fix. The ids are read before the try for exactly this case.
    const result = computeOrderProfit(overflowing());
    expect(result.orderId).toBe('demo:1:1001');
    expect(result.storeId).toBe('demo:1');
  });
});
