import { describe, expect, it } from 'vitest';
import {
  MAX_MINOR,
  PrecisionError,
  toMinor,
  toMinorFromDecimal,
  toMinorFromFloat,
} from '../src/money.js';

describe('toMinor', () => {
  it('accepts integers', () => {
    expect(toMinor(0)).toBe(0);
    expect(toMinor(-1_599)).toBe(-1_599);
  });

  it('rejects a fractional value, because that means major units leaked past an adapter', () => {
    expect(() => toMinor(15.99)).toThrow(PrecisionError);
  });

  it('rejects values whose basis-point product would leave the safe-integer range', () => {
    expect(() => toMinor(MAX_MINOR + 1)).toThrow(PrecisionError);
    expect(toMinor(MAX_MINOR) * 10_000).toBeLessThanOrEqual(Number.MAX_SAFE_INTEGER);
  });
});

describe('toMinorFromDecimal', () => {
  it('parses digit-wise, so the 1.005 case that defeats parseFloat is exact', () => {
    // parseFloat('1.005') * 100 === 100.49999999999999, which rounds DOWN to 100
    // and quietly shorts the merchant a halala on every order.
    expect(() => toMinorFromDecimal('1.005', 2)).toThrow(PrecisionError);
  });

  it.each([
    ['1500', 2, 150_000],
    ['10.50', 2, 1_050],
    ['10.5', 2, 1_050],
    ['10.500', 2, 1_050],
    ['0.50', 2, 50],
    ['0.00', 2, 0],
    ['-3.99', 2, -399],
    ['12.345', 3, 12_345],
  ])('parses %s at exponent %i to %i', (raw, exponent, expected) => {
    expect(toMinorFromDecimal(raw, exponent)).toBe(expected);
  });

  it('refuses to truncate significant digits rather than silently losing money', () => {
    expect(() => toMinorFromDecimal('10.999', 2)).toThrow(PrecisionError);
  });

  it('rejects anything that is not a decimal number', () => {
    expect(() => toMinorFromDecimal('SAR 10.00', 2)).toThrow(PrecisionError);
    expect(() => toMinorFromDecimal('', 2)).toThrow(PrecisionError);
    expect(() => toMinorFromDecimal('1e3', 2)).toThrow(PrecisionError);
  });
});

describe('toMinorFromFloat', () => {
  it('converts values a float can represent exactly', () => {
    expect(toMinorFromFloat(10.5, 2)).toBe(1_050);
    expect(toMinorFromFloat(0.1 + 0.2, 2)).toBe(30);
  });

  it('throws rather than inventing money when the float never held the amount', () => {
    expect(() => toMinorFromFloat(1.005, 2)).toThrow(PrecisionError);
  });

  it('throws on an exact half, which is genuinely ambiguous at an adapter boundary', () => {
    expect(() => toMinorFromFloat(1.5, 0)).toThrow(PrecisionError);
  });

  it('rejects non-finite values', () => {
    expect(() => toMinorFromFloat(Number.NaN, 2)).toThrow(PrecisionError);
    expect(() => toMinorFromFloat(Number.POSITIVE_INFINITY, 2)).toThrow(PrecisionError);
  });
});
