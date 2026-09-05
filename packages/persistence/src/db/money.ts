import { currencyExponent, toMinor, toMinorFromDecimal } from '@ghalla/contracts';
import type { CurrencyCode, Minor } from '@ghalla/contracts';

/**
 * The one place the integer domain meets the decimal column.
 *
 * Money is `numeric(_, 2)` in Postgres and a branded integer count of halalas
 * in the domain. Those are not in tension: `numeric` is exact decimal, not
 * float, and the `pg` driver hands it back as a STRING precisely so no
 * precision is lost on the way out. The column keeps the table readable to
 * anyone running a query by hand; the integer keeps the arithmetic exact in the
 * engine.
 *
 * What would break it is converting with `Number()` or `parseFloat()`, which is
 * the ordinary way to read a numeric column and is wrong here for the same
 * reason it is wrong everywhere else in this codebase: `parseFloat('1.005') *
 * 100` is `100.49999999999999`. The conversion below is digit-wise, through the
 * same checked constructor every adapter uses.
 */

/** Every money column in the schema. Chosen so `MAX_MINOR` fits: 9,007,199,254.74. */
export const MONEY_PRECISION = 14;
export const MONEY_SCALE = 2;

export class UnsupportedCurrencyError extends Error {
  constructor(currency: CurrencyCode) {
    super(
      `${currency} has ${String(currencyExponent(currency))} minor digits, and every money column in ` +
        `this schema is numeric(${String(MONEY_PRECISION)}, ${String(MONEY_SCALE)}). Persisting it would ` +
        `silently drop a digit. Supporting it means a migration to scale 3, not a cast here.`,
    );
    this.name = 'UnsupportedCurrencyError';
  }
}

/**
 * Guards the gap between what the domain can express and what the columns can
 * hold. `CURRENCY_CODES` still lists three-decimal currencies because they
 * exist; this schema cannot store them, and saying so loudly beats truncating.
 */
export function assertStorableCurrency(currency: CurrencyCode): void {
  if (currencyExponent(currency) !== MONEY_SCALE) throw new UnsupportedCurrencyError(currency);
}

/** `12345` → `"123.45"`. Never `toFixed`, which goes via a float. */
export function minorToNumeric(value: Minor): string {
  const negative = value < 0;
  const digits = String(negative ? -value : value).padStart(MONEY_SCALE + 1, '0');
  const whole = digits.slice(0, -MONEY_SCALE);
  const fraction = digits.slice(-MONEY_SCALE);
  return `${negative ? '-' : ''}${whole}.${fraction}`;
}

/** `"123.45"` → `12345`. Digit-wise; throws rather than truncating a third decimal. */
export function numericToMinor(raw: string): Minor {
  return toMinorFromDecimal(raw, MONEY_SCALE);
}

export function minorToNumericOrNull(value: Minor | null): string | null {
  return value === null ? null : minorToNumeric(value);
}

export function numericToMinorOrNull(raw: string | null): Minor | null {
  return raw === null ? null : numericToMinor(raw);
}

/**
 * Basis points are stored as plain integers, so this is a cast rather than a
 * conversion — but it goes through `toMinor`'s sibling check so a corrupted row
 * fails here rather than deep inside the engine's arithmetic.
 */
export function integerToMinor(value: number): Minor {
  return toMinor(value);
}
