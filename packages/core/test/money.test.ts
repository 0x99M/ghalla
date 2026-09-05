import { describe, expect, it } from 'vitest';
import { toBps, toMinor } from '@ghalla/contracts';
import type { Minor } from '@ghalla/contracts';
import {
  MoneyKernelError,
  addMinor,
  allocateMinor,
  clampMinor,
  mulBps,
  negateMinor,
  splitVatInclusive,
} from '../src/money.js';

const m = (n: number): Minor => toMinor(n);

describe('mulBps', () => {
  it('rounds half AWAY FROM ZERO, so a reversal exactly undoes a charge', () => {
    // 1000 × 5bps = 0.5 exactly. Math.round would give 1 and -0 — asymmetric,
    // leaving a halala behind on every refunded order.
    expect(mulBps(m(1_000), toBps(5))).toBe(1);
    expect(mulBps(m(-1_000), toBps(5))).toBe(-1);
    expect(Math.round(-0.5)).toBe(-0); // the behaviour this exists to avoid
  });

  it('is exactly antisymmetric across the whole range it will meet', () => {
    // `-x` in plain JS yields -0 when x is 0, and toBe compares with Object.is —
    // so the expectation has to normalize what the kernel already normalizes.
    const flip = (n: number): number => (n === 0 ? 0 : -n);
    for (let value = -5_000; value <= 5_000; value += 7) {
      for (const bps of [1, 5, 100, 275, 1_500, 9_999]) {
        expect(mulBps(m(-value), toBps(bps))).toBe(flip(mulBps(m(value), toBps(bps))));
      }
    }
  });

  it('computes a real card fee', () => {
    // SAR 575.00 at 2.75% = SAR 15.8125 → 1581 halalas.
    expect(mulBps(m(57_500), toBps(275))).toBe(1_581);
    // SAR 500.00 at 1.00% = SAR 5.00 exactly.
    expect(mulBps(m(50_000), toBps(100))).toBe(500);
  });

  it('never returns negative zero', () => {
    expect(Object.is(mulBps(m(-1), toBps(1)), 0)).toBe(true);
  });

  it('throws rather than silently losing precision above the safe range', () => {
    expect(() => mulBps(m(900_719_925_474), toBps(20_000))).toThrow(MoneyKernelError);
  });
});

describe('splitVatInclusive', () => {
  it('makes net + vat === gross by construction, never by luck', () => {
    for (let gross = 0; gross <= 3_000; gross += 1) {
      const { net, vat } = splitVatInclusive(m(gross), toBps(1_500));
      expect(net + vat).toBe(gross);
    }
  });

  it('extracts an exact rate exactly', () => {
    expect(splitVatInclusive(m(11_500), toBps(1_500))).toEqual({ net: 10_000, vat: 1_500 });
  });

  it('is the identity at a zero rate', () => {
    expect(splitVatInclusive(m(9_999), toBps(0))).toEqual({ net: 9_999, vat: 0 });
  });

  it('refuses a negative rate, which would make net exceed gross', () => {
    expect(() => splitVatInclusive(m(100), toBps(-1_500))).toThrow(MoneyKernelError);
  });
});

describe('allocateMinor', () => {
  const equal = (n: number, weight = 1_000): { key: string; weight: Minor }[] =>
    Array.from({ length: n }, (_, i) => ({ key: `L${String(i).padStart(2, '0')}`, weight: m(weight) }));

  const sum = (map: ReadonlyMap<string, Minor>): number => [...map.values()].reduce((a, b) => a + b, 0);

  it('holds the sum invariant exactly, and never invents a negative share', () => {
    // The case the design record names: drift-to-last apportionment produces a
    // NEGATIVE allocation here, a phantom surcharge that flips a SKU's margin
    // sign and fires a false loss-maker flag.
    const result = allocateMinor(m(7), equal(10));
    expect(sum(result)).toBe(7);
    expect([...result.values()].every((v) => v >= 0)).toBe(true);
    expect([...result.values()].filter((v) => v === 1)).toHaveLength(7);
  });

  it('keeps every share within one minor unit of exact', () => {
    const buckets = [
      { key: 'a', weight: m(3_333) },
      { key: 'b', weight: m(3_333) },
      { key: 'c', weight: m(3_334) },
    ];
    const result = allocateMinor(m(10_000), buckets);
    expect(sum(result)).toBe(10_000);
    for (const [key, share] of result) {
      const weight = buckets.find((b) => b.key === key)?.weight ?? 0;
      expect(Math.abs(share - (10_000 * weight) / 10_000)).toBeLessThanOrEqual(1);
    }
  });

  it('is invariant to the order the buckets arrive in', () => {
    const buckets = [
      { key: 'c', weight: m(500) },
      { key: 'a', weight: m(500) },
      { key: 'b', weight: m(500) },
    ];
    const forward = allocateMinor(m(101), buckets);
    const reversed = allocateMinor(m(101), [...buckets].reverse());
    expect([...forward.entries()].sort()).toEqual([...reversed.entries()].sort());
  });

  it('breaks ties by key, never by array index', () => {
    // Three equal lines, one halala to place. It must land on the same line
    // every time, or per-SKU margins churn between recomputes.
    const result = allocateMinor(m(1), equal(3));
    expect(result.get('L00')).toBe(1);
    expect(result.get('L01')).toBe(0);
    expect(result.get('L02')).toBe(0);
  });

  it('splits evenly when there is no revenue basis — the 100% discount order', () => {
    const zeroed = [
      { key: 'a', weight: m(0) },
      { key: 'b', weight: m(0) },
      { key: 'c', weight: m(0) },
    ];
    const result = allocateMinor(m(1_000), zeroed);
    expect(sum(result)).toBe(1_000);
    expect([...result.values()]).toEqual([334, 333, 333]);
  });

  it('allocates a negative total symmetrically', () => {
    const positive = allocateMinor(m(7), equal(10));
    const negative = allocateMinor(m(-7), equal(10));
    expect(sum(negative)).toBe(-7);
    for (const [key, value] of positive) expect(negative.get(key)).toBe(value === 0 ? 0 : -value);
  });

  it('holds the invariant across many shapes', () => {
    // Deterministic pseudo-random: the engine is pure and so are its tests.
    let seed = 20260905;
    const next = (max: number): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % max;
    };
    for (let trial = 0; trial < 400; trial += 1) {
      const count = 1 + next(9);
      const buckets = Array.from({ length: count }, (_, i) => ({
        key: `k${String(i)}`,
        weight: m(next(50_000)),
      }));
      const total = m(next(200_001) - 100_000);
      expect(sum(allocateMinor(total, buckets))).toBe(total);
    }
  });

  it('refuses to allocate a non-zero total across no buckets', () => {
    expect(() => allocateMinor(m(500), [])).toThrow(MoneyKernelError);
    expect(allocateMinor(m(0), []).size).toBe(0);
  });

  it('refuses duplicate keys, which would silently drop a line', () => {
    expect(() => allocateMinor(m(10), [{ key: 'a', weight: m(1) }, { key: 'a', weight: m(1) }])).toThrow(
      MoneyKernelError,
    );
  });
});

describe('addMinor / negateMinor / clampMinor', () => {
  it('sums and negates without producing negative zero', () => {
    expect(addMinor(m(100), m(-40), m(-60))).toBe(0);
    expect(Object.is(addMinor(m(100), m(-100)), 0)).toBe(true);
    expect(Object.is(negateMinor(m(0)), 0)).toBe(true);
    expect(negateMinor(m(250))).toBe(-250);
  });

  it('clamps to a floor and a cap, and treats null as unbounded', () => {
    expect(clampMinor(m(50), m(100), null)).toBe(100);
    expect(clampMinor(m(50_000), null, m(20_000))).toBe(20_000);
    expect(clampMinor(m(500), m(100), m(20_000))).toBe(500);
    expect(clampMinor(m(500), null, null)).toBe(500);
  });
});
