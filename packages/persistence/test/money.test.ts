import { describe, expect, it } from 'vitest';
import { MAX_MINOR, PrecisionError, toMinor } from '@ghalla/contracts';
import type { CurrencyCode } from '@ghalla/contracts';
import {
  MONEY_PRECISION,
  MONEY_SCALE,
  UnsupportedCurrencyError,
  assertStorableCurrency,
  integerToMinor,
  minorToNumeric,
  minorToNumericOrNull,
  numericToMinor,
  numericToMinorOrNull,
} from '../src/db/money.js';

/**
 * The codec between the integer domain and the `numeric(14, 2)` column.
 *
 * Everything this system claims about exact money passes through these six
 * functions. A halala lost here is lost in every row of every table, and it is
 * lost silently: the column would still read as a plausible amount.
 */

describe('minorToNumeric', () => {
  it('writes zero as an amount rather than a bare digit', () => {
    // '0' and '0.00' are the same number to Postgres, but the column is what a
    // merchant reads when they query by hand, and it should read as money.
    expect(minorToNumeric(toMinor(0))).toBe('0.00');
  });

  it('keeps a sub-riyal amount below the decimal point', () => {
    // The failure this guards is padding: without it, one halala becomes SAR 1.
    expect(minorToNumeric(toMinor(1))).toBe('0.01');
    expect(minorToNumeric(toMinor(5))).toBe('0.05');
    expect(minorToNumeric(toMinor(9))).toBe('0.09');
    expect(minorToNumeric(toMinor(99))).toBe('0.99');
  });

  it('places the decimal point at the first carry', () => {
    expect(minorToNumeric(toMinor(100))).toBe('1.00');
    expect(minorToNumeric(toMinor(101))).toBe('1.01');
    expect(minorToNumeric(toMinor(12_345))).toBe('123.45');
  });

  it('carries the sign, which reversals and negative margins need', () => {
    expect(minorToNumeric(toMinor(-1))).toBe('-0.01');
    expect(minorToNumeric(toMinor(-99))).toBe('-0.99');
    expect(minorToNumeric(toMinor(-12_345))).toBe('-123.45');
  });

  it('writes a signed zero as an unsigned one', () => {
    // A break-even order is not a loss. '-0.00' in the column would sort and read
    // as one, and `1 / -0` is -Infinity for anything downstream that divides.
    expect(minorToNumeric(toMinor(-0))).toBe('0.00');
  });

  it('reaches the ceiling the column precision was chosen for', () => {
    // Precision 14 exists so MAX_MINOR fits exactly: ten whole digits and two
    // decimal ones. One more digit and the write would fail rather than round.
    expect(minorToNumeric(toMinor(MAX_MINOR))).toBe('9007199254.74');
    expect(minorToNumeric(toMinor(-MAX_MINOR))).toBe('-9007199254.74');
  });

  it('never emits exponential notation, which numeric cannot parse', () => {
    for (const value of [MAX_MINOR, 1, 0, -MAX_MINOR]) {
      expect(minorToNumeric(toMinor(value))).toMatch(/^-?\d+\.\d{2}$/);
    }
  });
});

/**
 * A spread of magnitudes rather than a random sample, so a failure names the
 * same value every run: every digit position, and the carries either side of
 * each power of ten, which is where a slice or a pad goes wrong.
 */
const MAGNITUDES: readonly number[] = (() => {
  const values: number[] = [0];
  for (let power = 0; power <= 11; power += 1) {
    const base = 10 ** power;
    values.push(base - 1, base, base + 1, base * 5 + 55);
  }
  return values.filter((value) => value <= MAX_MINOR);
})();

describe('the round trip', () => {
  it('returns the same integer for every magnitude a money column can hold', () => {
    for (const value of MAGNITUDES) {
      for (const signed of [toMinor(value), toMinor(-value)]) {
        expect(numericToMinor(minorToNumeric(signed))).toBe(signed);
      }
    }
  });

  it('survives the ceiling, where a float would already have stopped being exact', () => {
    expect(numericToMinor(minorToNumeric(toMinor(MAX_MINOR)))).toBe(MAX_MINOR);
  });
});

describe('numericToMinor', () => {
  it('reads what a numeric(14, 2) column actually returns', () => {
    // The `pg` driver hands a numeric back as a string precisely so this
    // conversion can be digit-wise. `Number('123.45') * 100` is 12344.999…
    expect(numericToMinor('123.45')).toBe(12_345);
    expect(numericToMinor('0.00')).toBe(0);
    expect(numericToMinor('-0.01')).toBe(-1);
  });

  it('accepts a trailing zero beyond the scale, because it carries no money', () => {
    expect(numericToMinor('12.340')).toBe(1_234);
  });

  it('refuses to truncate a third significant decimal', () => {
    // This is the case that pays for the whole module: a merchant's 1.005
    // becoming 1.00 is a halala they were charged and never see again.
    expect(() => numericToMinor('1.005')).toThrow(PrecisionError);
  });

  it('refuses a value that is not a decimal number at all', () => {
    // A column read that returns this has been corrupted or mis-selected;
    // failing here beats letting NaN reach the arithmetic.
    expect(() => numericToMinor('')).toThrow(PrecisionError);
    expect(() => numericToMinor('1.2e3')).toThrow(PrecisionError);
  });

  it('refuses an amount above the safe-arithmetic ceiling', () => {
    // Above MAX_MINOR the basis-point multiplications stop being exact silently,
    // which is the one failure integer money exists to prevent.
    expect(() => numericToMinor('9007199254.75')).toThrow(PrecisionError);
  });
});

describe('the null variants', () => {
  it('keeps a nullable money column null rather than storing zero', () => {
    // A rejected profit row has no margin at all. Zero is a different claim: it
    // says the order broke even, and the dashboard would rank it as such.
    expect(minorToNumericOrNull(null)).toBeNull();
    expect(numericToMinorOrNull(null)).toBeNull();
  });

  it('converts exactly as the non-null form does when a value is present', () => {
    expect(minorToNumericOrNull(toMinor(-12_345))).toBe('-123.45');
    expect(numericToMinorOrNull('-123.45')).toBe(-12_345);
    expect(numericToMinorOrNull('0.00')).toBe(0);
  });
});

describe('assertStorableCurrency', () => {
  it('accepts every currency whose minor unit is two digits', () => {
    for (const currency of ['SAR', 'AED', 'USD'] as const) {
      expect(() => {
        assertStorableCurrency(currency);
      }).not.toThrow();
    }
  });

  it('rejects a three-decimal currency instead of dropping the third digit', () => {
    // KWD 1.234 in a numeric(_, 2) column becomes KWD 1.23. The guard is the
    // whole reason CURRENCY_CODES may list a currency this schema cannot store.
    for (const currency of ['KWD', 'BHD'] as const) {
      expect(() => {
        assertStorableCurrency(currency);
      }).toThrow(UnsupportedCurrencyError);
    }
  });

  it('names itself, so a caller can tell an unsupported currency from a bad amount', () => {
    let caught: unknown;
    try {
      assertStorableCurrency('KWD');
    } catch (error) {
      caught = error;
    }
    expect((caught as Error).name).toBe('UnsupportedCurrencyError');
    // The message has to say what to do about it: a scale-3 migration, not a cast.
    expect((caught as Error).message).toContain(
      `numeric(${String(MONEY_PRECISION)}, ${String(MONEY_SCALE)})`,
    );
  });

  it('does not silently pass a currency outside the known set', () => {
    // `currencyExponent` returns undefined for one, and `undefined !== 2` throws
    // rather than treating it as storable.
    expect(() => {
      assertStorableCurrency('EUR' as CurrencyCode);
    }).toThrow(UnsupportedCurrencyError);
  });
});

describe('integerToMinor', () => {
  it('passes an integer column through the same checked constructor as everything else', () => {
    expect(integerToMinor(1_500)).toBe(1_500);
    expect(integerToMinor(-1_500)).toBe(-1_500);
    expect(Object.is(integerToMinor(-0), 0)).toBe(true);
  });

  it('fails on a corrupted row here rather than deep inside the engine', () => {
    // A fractional value in an integer column means a major-unit amount got past
    // an adapter; the engine would carry it silently until a total stopped tying.
    expect(() => integerToMinor(15.99)).toThrow(PrecisionError);
    expect(() => integerToMinor(MAX_MINOR + 1)).toThrow(PrecisionError);
  });
});
