import type { Brand } from './brand.js';

/**
 * Money. An integer count of minor units — halalas for SAR.
 *
 * Signed: reversals, allocations and contribution margins all go negative.
 * There is no major-unit representation anywhere in this system. Formatting
 * happens at the presentation edge and never returns to the domain.
 */
export type Minor = Brand<number, 'Minor'>;

/** An integer count of basis points. 1500 = 15%. Never a 0.15 float. */
export type Bps = Brand<number, 'Bps'>;

export const CURRENCY_CODES = ['SAR', 'AED', 'KWD', 'BHD', 'USD'] as const;
export type CurrencyCode = (typeof CURRENCY_CODES)[number];

/**
 * The ceiling on any `Minor`.
 *
 * Not chosen for magnitude — SAR 9 billion is already absurd for a Salla store.
 * It is chosen so that `value * 10_000` (the intermediate in every basis-point
 * multiplication) stays inside `Number.MAX_SAFE_INTEGER`. Above this the
 * arithmetic stops being exact silently, which is the one failure mode integer
 * money exists to prevent.
 */
export const MAX_MINOR = 900_719_925_474;

/** Thrown when a value cannot be represented exactly. Never caught in the engine. */
export class PrecisionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PrecisionError';
  }
}

/**
 * Non-throwing companion to `toMinor`. Exists so runtime validators can report a
 * field path instead of unwinding on the first bad number in a payload.
 */
export function isMinor(value: number): value is Minor {
  return Number.isSafeInteger(value) && value <= MAX_MINOR && value >= -MAX_MINOR;
}

export function isBps(value: number): value is Bps {
  return Number.isSafeInteger(value);
}

/** The only constructor for `Minor`. */
export function toMinor(value: number): Minor {
  if (!Number.isSafeInteger(value)) {
    throw new PrecisionError(
      `Money must be an integer count of minor units; received ${String(value)}. ` +
        `A fractional value here means a major-unit amount leaked past an adapter boundary.`,
    );
  }
  if (value > MAX_MINOR || value < -MAX_MINOR) {
    throw new PrecisionError(`Money out of range: ${String(value)} exceeds ±${String(MAX_MINOR)}.`);
  }
  return value as Minor;
}

export function toBps(value: number): Bps {
  if (!Number.isSafeInteger(value)) {
    throw new PrecisionError(`Basis points must be an integer; received ${String(value)}.`);
  }
  return value as Bps;
}

const EXPONENTS: Readonly<Record<CurrencyCode, 0 | 2 | 3>> = {
  SAR: 2,
  AED: 2,
  KWD: 3,
  BHD: 3,
  USD: 2,
};

/** Minor units per major unit, as a power of ten. */
export function currencyExponent(currency: CurrencyCode): 0 | 2 | 3 {
  return EXPONENTS[currency];
}

const DECIMAL = /^([+-]?)(\d+)(?:\.(\d*))?$/;

/**
 * Adapter boundary: convert a platform's decimal *string* to minor units.
 *
 * Digit-wise, never via `parseFloat` — `parseFloat("1.005") * 100` is
 * `100.49999999999999`, and rounding that gives the merchant a halala less than
 * they were charged, on every order, forever.
 *
 * Trailing zeros beyond the currency's precision are discarded. Significant
 * digits beyond it throw, because silently truncating a merchant's money is
 * worse than failing the ingestion job.
 */
export function toMinorFromDecimal(raw: string, exponent: number): Minor {
  const match = DECIMAL.exec(raw.trim());
  if (match === null) {
    throw new PrecisionError(`Not a decimal number: ${JSON.stringify(raw)}.`);
  }
  const [, sign = '', whole = '0', fraction = ''] = match;

  const kept = fraction.slice(0, exponent).padEnd(exponent, '0');
  const dropped = fraction.slice(exponent);
  if (/[1-9]/.test(dropped)) {
    throw new PrecisionError(
      `${JSON.stringify(raw)} carries more precision than ${String(exponent)} minor digits allow. ` +
        `Refusing to truncate money.`,
    );
  }

  const digits = `${whole}${kept}`.replace(/^0+(?=\d)/, '');
  const value = Number(digits);
  if (!Number.isSafeInteger(value)) {
    throw new PrecisionError(`${JSON.stringify(raw)} is too large to represent exactly.`);
  }
  return toMinor(sign === '-' ? -value : value);
}

/**
 * Adapter boundary of last resort: convert a platform's JSON *number* to minor
 * units. Prefer `toMinorFromDecimal` whenever the platform sends a string.
 *
 * Rounds half away from zero, but only after asserting the value was already
 * within 1e-6 of a whole minor unit. A residual larger than that means the float
 * never represented the amount exactly, and rounding it would invent money.
 */
export function toMinorFromFloat(value: number, exponent: number): Minor {
  if (!Number.isFinite(value)) {
    throw new PrecisionError(`Money must be finite; received ${String(value)}.`);
  }
  const scaled = value * 10 ** exponent;
  const nearest = Math.sign(scaled) * Math.floor(Math.abs(scaled) + 0.5);
  if (Math.abs(scaled - nearest) > 1e-6) {
    throw new PrecisionError(
      `${String(value)} is not representable as an integer count of minor units at exponent ` +
        `${String(exponent)} (scaled to ${String(scaled)}). The platform sent a float it could not represent; ` +
        `read the decimal string field instead.`,
    );
  }
  return toMinor(nearest);
}
