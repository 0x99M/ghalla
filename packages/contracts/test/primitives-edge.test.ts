import { describe, expect, it } from 'vitest';
import {
  MalformedIdError,
  idFromString,
  isCustomerRef,
  isPlatformId,
  toCalcVersion,
  toOrderId,
  toOrderItemId,
  toPlatformId,
  toReversalId,
  toShipmentId,
  toStoreId,
} from '../src/ids.js';
import { toRawPayload } from '../src/ingest.js';
import type { Ingested } from '../src/ingest.js';
import {
  MAX_MINOR,
  PrecisionError,
  currencyExponent,
  isBps,
  isMinor,
  toBps,
  toMinor,
  toMinorFromDecimal,
} from '../src/money.js';
import type { CurrencyCode, MinorExponent } from '../src/money.js';
import { MalformedTimestampError, isInstant, isLocalDate, toInstant, toLocalDate } from '../src/time.js';

const platform = toPlatformId('example_platform');
const store = toStoreId(platform, '12345');
const order = toOrderId(store, '999');

describe('toShipmentId', () => {
  it('derives one id for a parcel however many times it arrives', () => {
    // Shipments are the largest cost line in the model and they arrive from two
    // directions at once — a live webhook and an overlapping backfill. A minted
    // id would differ per arrival and the freight would be counted twice.
    expect(toShipmentId(store, 'SH-1')).toBe(toShipmentId(store, 'SH-1'));
    expect(toShipmentId(store, 'SH-1')).toBe('example_platform:12345:SH-1');
  });

  it('is scoped to the store, so two merchants on one platform cannot share a parcel', () => {
    const other = toStoreId(platform, '54321');
    expect(toShipmentId(store, 'SH-1')).not.toBe(toShipmentId(other, 'SH-1'));
  });

  it('refuses separator characters in the platform id', () => {
    expect(() => toShipmentId(store, 'SH:1')).toThrow(MalformedIdError);
    expect(() => toShipmentId(store, 'SH#1')).toThrow(MalformedIdError);
    expect(() => toShipmentId(store, '')).toThrow(MalformedIdError);
  });
});

describe('toReversalId', () => {
  it('hangs the reversal off the order it reverses', () => {
    // A redelivered refund webhook must land on the row it already wrote.
    // Without the order in the key, two stores' reversal number 7 are one row.
    expect(toReversalId(order, '7')).toBe('example_platform:12345:999#rev:7');
    expect(toReversalId(order, '7')).toBe(toReversalId(order, '7'));
  });

  it('cannot be impersonated by an order line, because a line id may not carry a colon', () => {
    // Both live under the same `#`, so the only thing keeping a line called
    // `rev:7` off the reversal's own id is the separator rejection.
    expect(() => toOrderItemId(order, 'rev:7')).toThrow(MalformedIdError);
    expect(() => toReversalId(order, 'rev:7')).toThrow(MalformedIdError);
    expect(toOrderItemId(order, 'rev')).not.toBe(toReversalId(order, '7'));
  });
});

describe('idFromString', () => {
  it('returns a derived id unchanged, so a row read back addresses the entity it was written under', () => {
    const item = toOrderItemId(order, '3');
    expect(idFromString(item)).toBe(item);
  });

  it('refuses an empty identifier', () => {
    // A text column that came back empty is a corrupt row, not an entity, and it
    // would otherwise be handed to a repository as a perfectly ordinary key.
    expect(() => idFromString('')).toThrow(MalformedIdError);
  });
});

describe('toCalcVersion', () => {
  it('accepts a positive integer', () => {
    expect(toCalcVersion(1)).toBe(1);
    expect(toCalcVersion(2)).toBe(2);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
    'rejects %s, which would leave "recompute every row below the current version" with nothing to compare',
    (version) => {
      expect(() => toCalcVersion(version)).toThrow(MalformedIdError);
    },
  );
});

describe('isPlatformId', () => {
  it.each<[string, boolean]>([
    ['example_platform', true],
    ['example-platform-2', true],
    ['a'.repeat(64), true],
    ['Example Platform', false],
    ['a:b', false],
    ['a#b', false],
    ['_leading', false],
    ['-leading', false],
    ['a'.repeat(65), false],
    ['', false],
  ])('reads %s as valid=%s, and toPlatformId agrees', (slug, valid) => {
    // Every store, order, item and reversal id begins with this slug, so one
    // carrying a colon would re-partition every id derived from it. The
    // predicate exists so a validator can name the offending field instead of
    // unwinding, which only works while it accepts exactly what the constructor
    // accepts — otherwise the constructor throws from inside a zod transform,
    // past all of zod's reporting.
    expect(isPlatformId(slug)).toBe(valid);
    if (valid) {
      expect(toPlatformId(slug)).toBe(slug);
    } else {
      expect(() => toPlatformId(slug)).toThrow(MalformedIdError);
    }
  });
});

describe('isCustomerRef', () => {
  it('accepts only a full-length lowercase digest, because anything shorter is not the hash it claims to be', () => {
    // The last line is the one that matters: platform customer ids are small
    // sequential integers, and one stored here unhashed identifies a person —
    // the single property this field exists to lack.
    expect(isCustomerRef('a'.repeat(64))).toBe(true);
    expect(isCustomerRef('0123456789abcdef'.repeat(4))).toBe(true);
    expect(isCustomerRef('A'.repeat(64))).toBe(false);
    expect(isCustomerRef('a'.repeat(63))).toBe(false);
    expect(isCustomerRef('a'.repeat(65))).toBe(false);
    expect(isCustomerRef('4471')).toBe(false);
  });
});

describe('isInstant', () => {
  it.each<[string, boolean]>([
    ['2026-09-05T18:30:00.000Z', true],
    ['2026-09-05T23:59:59.999Z', true],
    ['2028-02-29T00:00:00.000Z', true],
    ['2026-09-05T21:30:00.000+03:00', false],
    ['2026-09-05T18:30:00Z', false],
    ['2026-02-30T00:00:00.000Z', false],
    ['2026-13-01T00:00:00.000Z', false],
    ['2026-00-01T00:00:00.000Z', false],
    ['2026-09-00T00:00:00.000Z', false],
    ['2026-09-05T24:00:00.000Z', false],
    ['2026-09-05T18:60:00.000Z', false],
    ['2026-09-05T18:30:60.000Z', false],
    ['', false],
  ])('reads %s as valid=%s, and toInstant agrees', (raw, valid) => {
    // The predicate and the constructor are used as a pair — refine with one,
    // transform with the other — so a value they disagree about becomes an
    // exception thrown from inside the transform, past all of zod's reporting.
    expect(isInstant(raw)).toBe(valid);
    if (valid) {
      expect(toInstant(raw)).toBe(raw);
    } else {
      expect(() => toInstant(raw)).toThrow(MalformedTimestampError);
    }
  });
});

describe('isLocalDate', () => {
  const LENGTHS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

  it.each(LENGTHS.map((length, index): [number, number] => [index + 1, length]))(
    'ends month %i of a common year on day %i and rejects the day after',
    (month, length) => {
      // `new Date('2027-09-31')` rolls over to 1 October rather than failing,
      // which would move an order into a business date the merchant never had.
      // The arithmetic here is what makes the pure layer able to say no.
      const mm = String(month).padStart(2, '0');
      expect(isLocalDate(`2027-${mm}-${String(length).padStart(2, '0')}`)).toBe(true);
      expect(isLocalDate(`2027-${mm}-${String(length + 1).padStart(2, '0')}`)).toBe(false);
    },
  );

  it('applies the full leap-year rule, and agrees with toLocalDate on it', () => {
    expect(isLocalDate('2028-02-29')).toBe(true);
    expect(isLocalDate('2000-02-29')).toBe(true);
    expect(isLocalDate('2027-02-29')).toBe(false);
    expect(isLocalDate('2100-02-29')).toBe(false);

    expect(toLocalDate('2028-02-29')).toBe('2028-02-29');
    expect(() => toLocalDate('2100-02-29')).toThrow(MalformedTimestampError);
  });

  it.each(['2027-09-00', '2027-00-09', '2027-9-5', '2027-09-05T00:00:00.000Z', ''])(
    'rejects %s, and toLocalDate agrees',
    (raw) => {
      // An unpadded or over-long form has to fail here rather than downstream:
      // the business date is a text column, and a row written as `2027-9-5`
      // sorts and groups apart from every other day in the same month.
      expect(isLocalDate(raw)).toBe(false);
      expect(() => toLocalDate(raw)).toThrow(MalformedTimestampError);
    },
  );
});

describe('currencyExponent', () => {
  it.each<[CurrencyCode, MinorExponent]>([
    ['SAR', 2],
    ['AED', 2],
    ['USD', 2],
    ['KWD', 3],
    ['BHD', 3],
  ])('scales %s by ten to the %i', (currency, exponent) => {
    expect(currencyExponent(currency)).toBe(exponent);
  });

  it('is the reason the same decimal string is two different amounts', () => {
    // The Gulf's three-decimal currencies are the whole point of the parameter.
    // Read a fils amount as if it were halalas and every figure is out by 10x.
    expect(toMinorFromDecimal('10.500', currencyExponent('KWD'))).toBe(10_500);
    expect(toMinorFromDecimal('10.50', currencyExponent('SAR'))).toBe(1_050);
  });

  it('cannot let a currency the package does not know silently become money', () => {
    // Unreachable from TypeScript, where the argument is a closed union. An
    // adapter written in JavaScript is the case this pairing exists for: the
    // lookup returns nothing, and the converter refuses the nothing.
    const scale = currencyExponent('EUR' as CurrencyCode);
    expect(() => toMinorFromDecimal('10.00', scale)).toThrow(PrecisionError);
  });
});

describe('isMinor', () => {
  it('answers instead of throwing, so a payload with three bad amounts reports three field paths', () => {
    expect(isMinor(1_500)).toBe(true);
    expect(isMinor(0)).toBe(true);
    expect(isMinor(-1_599)).toBe(true);
    expect(isMinor(15.99)).toBe(false);
    expect(isMinor(Number.NaN)).toBe(false);
    expect(isMinor(Number.POSITIVE_INFINITY)).toBe(false);
  });

  it('draws the range at exactly the point the basis-point product stops being exact', () => {
    expect(isMinor(MAX_MINOR)).toBe(true);
    expect(isMinor(-MAX_MINOR)).toBe(true);
    expect(isMinor(MAX_MINOR + 1)).toBe(false);
    expect(isMinor(-MAX_MINOR - 1)).toBe(false);
    expect(() => toMinor(MAX_MINOR + 1)).toThrow(PrecisionError);
  });

  it('reports whether a value is representable, not whether it is already canonical', () => {
    // `JSON.parse('-0')` is -0, which is representable and passes. Only toMinor
    // makes it comparable, since Object.is(-0, 0) is false and that is what
    // toBe compares with. This is why a validator must transform through the
    // constructor rather than cast on the back of the predicate.
    expect(isMinor(-0)).toBe(true);
    expect(Object.is(toMinor(-0), 0)).toBe(true);
  });
});

describe('isBps', () => {
  it('rejects a rate typed as 2.75 instead of 275', () => {
    // 2.75 read as basis points is 0.0275%, so a gateway fee comes out roughly
    // a hundredfold light — and lands on an integer often enough to look real.
    expect(isBps(2.75)).toBe(false);
    expect(() => toBps(2.75)).toThrow(PrecisionError);
    expect(isBps(275)).toBe(true);
  });

  it('leaves the scale unbounded, because a margin is not a rate', () => {
    // A return to origin carries two shipping legs and no revenue, so its margin
    // in basis points is legitimately far below -10 000. Bounding Bps here would
    // reject the loss the model exists to surface.
    expect(isBps(-25_000)).toBe(true);
    expect(toBps(-25_000)).toBe(-25_000);
  });

  it('normalises a negative-zero margin, which a loss-maker query would otherwise drop', () => {
    // `marginBps < 0` is false for -0, so the row vanishes from the one report
    // it belongs in — and JSON.stringify writes "0", so a fixture cannot show
    // you why.
    expect(Object.is(toBps(-0), 0)).toBe(true);
    expect(Object.is(toBps(0), 0)).toBe(true);
  });
});

describe('toMinorFromDecimal', () => {
  it.each<[string, MinorExponent, number]>([
    ['1500', 0, 1_500],
    ['15.0', 0, 15],
    ['12.5', 3, 12_500],
    ['12.5000', 3, 12_500],
    ['0.001', 3, 1],
    ['+10.50', 2, 1_050],
    ['00010.50', 2, 1_050],
    [' 10.50 ', 2, 1_050],
  ])('parses %s at exponent %i to %i', (raw, exponent, expected) => {
    expect(toMinorFromDecimal(raw, exponent)).toBe(expected);
  });

  it('refuses to drop a significant digit even when the currency has three of them', () => {
    // A four-decimal amount in a thousandths currency is not a rounding
    // question. Truncating it silently is how a cost line ends up understated
    // on every order of that SKU.
    expect(() => toMinorFromDecimal('12.5001', 3)).toThrow(PrecisionError);
    expect(() => toMinorFromDecimal('15.5', 0)).toThrow(PrecisionError);
  });

  it('carries the ceiling on Minor through to the decimal boundary', () => {
    expect(toMinorFromDecimal('9007199254.74', 2)).toBe(MAX_MINOR);
    expect(() => toMinorFromDecimal('9007199254.75', 2)).toThrow(PrecisionError);
  });

  it('refuses a whole part too long to hold exactly rather than rounding it', () => {
    // Beyond 2^53 the digits stop being the number. A silent Number() here
    // would return something plausible and wrong.
    expect(() => toMinorFromDecimal('99999999999999999999', 2)).toThrow(PrecisionError);
  });
});

interface CanonicalThing {
  readonly id: string;
}

const ingested: Ingested<CanonicalThing> = {
  canonical: { id: 'example_platform:12345:999' },
  raw: toRawPayload(Uint8Array.from([0x7b, 0xff, 0x7d])),
  fetchedAt: toInstant('2026-09-05T18:30:00.000Z'),
  adapterVersion: '1.0.0',
};

describe('the ingestion boundary', () => {
  it('keeps the received bytes as bytes, and beside the canonical value rather than inside it', () => {
    // Signature verification runs over what actually arrived, so the payload
    // must not be copied, decoded or re-encoded on the way through: 0xff is not
    // valid UTF-8 and a string round trip would replace it, after which the HMAC
    // can never match.
    const bytes = Uint8Array.from([0x7b, 0xff, 0x7d]);
    expect(toRawPayload(bytes)).toBe(bytes);
    expect('raw' in ingested.canonical).toBe(false);
  });

  it('does not let the wrapper stand in for the canonical type it wraps', () => {
    // @ts-expect-error Ingested<T> is deliberately not assignable to T. The raw
    // payload is where the names, phone numbers and addresses live, so the
    // boundary has to be a compile error rather than a convention.
    const leaked: CanonicalThing = ingested;
    expect(leaked).toBeDefined();
  });

  it('cannot be flattened onto the canonical type by a spread', () => {
    // `{ ...canonical, raw }` is the single line that defeats "raw lives only at
    // the boundary" when it is written as a rule. Excess-property checking on a
    // fresh object literal is what makes the rule enforceable instead.
    // @ts-expect-error `raw` is not a property of the canonical type.
    const smuggled: CanonicalThing = { ...ingested.canonical, raw: ingested.raw };
    expect(smuggled).toBeDefined();
  });
});
