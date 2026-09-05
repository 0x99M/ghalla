import { describe, expect, it } from 'vitest';
import {
  COST_SOURCES,
  MalformedIdError,
  MalformedTimestampError,
  PrecisionError,
  toInstant,
} from '@ghalla/contracts';
import {
  toBpsFromColumn,
  toBpsFromColumnOrNull,
  toCalcVersionFromColumn,
  toDateFromInstant,
  toDateFromInstantOrNull,
  toEnumFromColumn,
  toIdFromColumn,
  toIdFromColumnOrNull,
  toInstantFromDate,
  toInstantFromDateOrNull,
  toLocalDateFromColumn,
} from '../src/db/codec.js';

/**
 * Row values in, domain values out.
 *
 * Persistence is allowed to hold a `Date`; it is not allowed to let one escape,
 * because the engine is pure, `Date` does not survive the JSON round trip the
 * golden fixtures depend on, and a `Date` printed anywhere carries the reader's
 * own timezone rather than the store's.
 */

const CANONICAL = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

describe('timestamptz to Instant', () => {
  it('produces exactly the canonical YYYY-MM-DDTHH:mm:ss.sssZ shape', () => {
    const instant = toInstantFromDate(new Date(Date.UTC(2026, 2, 1, 18, 30, 0, 0)));
    expect(instant).toBe('2026-03-01T18:30:00.000Z');
    expect(instant).toMatch(CANONICAL);
  });

  it('keeps the milliseconds a shorter form would drop', () => {
    // Two webhook deliveries a few milliseconds apart order correctly only if
    // the field that orders them keeps the digits.
    expect(toInstantFromDate(new Date(Date.UTC(2026, 2, 1, 18, 30, 0, 7)))).toBe('2026-03-01T18:30:00.007Z');
  });

  it('normalizes to UTC, so a Riyadh timestamp is not stored three hours out', () => {
    // The domain rejects offset forms rather than normalizing them, precisely
    // because a comparison that forgets to normalize is a silent three-hour
    // error in a country that is UTC+3.
    expect(toInstantFromDate(new Date('2026-03-01T21:30:00+03:00'))).toBe('2026-03-01T18:30:00.000Z');
  });

  it('refuses a date the canonical form cannot express', () => {
    // Beyond year 9999 `toISOString` emits an expanded '+275760-…' year. Letting
    // that through would put a string in an Instant column that nothing
    // downstream can parse.
    expect(() => toInstantFromDate(new Date(8.64e15))).toThrow(MalformedTimestampError);
  });

  it('fails on an unrepresentable date rather than emitting a placeholder', () => {
    expect(() => toInstantFromDate(new Date(Number.NaN))).toThrow(RangeError);
  });

  it('keeps a null timestamp null, because unset and epoch are different facts', () => {
    // `deliveredAt` unset means the parcel has not arrived. 1970 means it did.
    expect(toInstantFromDateOrNull(null)).toBeNull();
    expect(toInstantFromDateOrNull(new Date(Date.UTC(2026, 2, 1)))).toBe('2026-03-01T00:00:00.000Z');
  });
});

describe('Instant to timestamptz', () => {
  it('writes the same moment the domain read', () => {
    const date = toDateFromInstant(toInstant('2026-03-01T18:30:00.000Z'));
    expect(date.getTime()).toBe(Date.UTC(2026, 2, 1, 18, 30, 0, 0));
  });

  it('round-trips an instant unchanged, which is what makes a stored fact stable', () => {
    for (const raw of ['2026-01-01T00:00:00.000Z', '2026-12-31T23:59:59.999Z', '2024-02-29T12:00:00.000Z']) {
      expect(toInstantFromDate(toDateFromInstant(toInstant(raw)))).toBe(raw);
    }
  });

  it('keeps a null instant null', () => {
    expect(toDateFromInstantOrNull(null)).toBeNull();
    expect(toDateFromInstantOrNull(toInstant('2026-03-01T00:00:00.000Z'))?.getTime()).toBe(
      Date.UTC(2026, 2, 1),
    );
  });
});

describe('date column to LocalDate', () => {
  it('accepts the YYYY-MM-DD a date column returns in string mode', () => {
    expect(toLocalDateFromColumn('2026-03-01')).toBe('2026-03-01');
  });

  it('rejects a calendar date that does not exist', () => {
    // Validating rather than casting is the point: `new Date('2026-02-30')`
    // rolls over to March, so a business date could migrate a day on a read.
    expect(() => toLocalDateFromColumn('2026-02-30')).toThrow(MalformedTimestampError);
  });

  it('rejects an instant handed to it in place of a business date', () => {
    // The two are different facts: one is UTC, the other is store-local, and
    // bucketing an order by the wrong one moves it a day for every Riyadh
    // evening order.
    expect(() => toLocalDateFromColumn('2026-03-01T18:30:00.000Z')).toThrow(MalformedTimestampError);
  });
});

describe('text column to a typed id', () => {
  it('rehydrates the id the derivation minted', () => {
    expect(toIdFromColumn<'order'>('demo:1:1001')).toBe('demo:1:1001');
  });

  it('rejects an empty id, which would join to every row or none', () => {
    expect(() => toIdFromColumn<'order'>('')).toThrow(MalformedIdError);
  });

  it('keeps a null foreign key null', () => {
    // `costHistoryId` is null when a line had no cost at all — a different fact
    // from a cost of zero, and the one that degrades confidence.
    expect(toIdFromColumnOrNull<'costHistory'>(null)).toBeNull();
    expect(toIdFromColumnOrNull<'costHistory'>('ch_1')).toBe('ch_1');
  });
});

describe('integer column to Bps', () => {
  it('reads a rate as an integer count of basis points', () => {
    expect(toBpsFromColumn(1_500)).toBe(1_500);
  });

  it('accepts a negative rate, because a margin in basis points is signed', () => {
    // `marginBps` is legitimately below zero, and far below -10 000 on a return
    // to origin. Bps is a scale, not a range.
    expect(toBpsFromColumn(-12_500)).toBe(-12_500);
  });

  it('rejects a rate typed as 2.75 instead of 275', () => {
    // The percent-versus-basis-point slip is a hundredfold error in the
    // flattering direction, and it looks entirely plausible in a column.
    expect(() => toBpsFromColumn(2.75)).toThrow(PrecisionError);
  });

  it('keeps a null rate null, which is how "no cap" is stored', () => {
    expect(toBpsFromColumnOrNull(null)).toBeNull();
    expect(toBpsFromColumnOrNull(275)).toBe(275);
  });
});

describe('integer column to CalcVersion', () => {
  it('reads the version that produced a stored result', () => {
    expect(toCalcVersionFromColumn(1)).toBe(1);
  });

  it('rejects a version that is not a positive integer', () => {
    // The recompute sweep asks for everything BELOW the current version. A zero
    // or negative value there would make every row look permanently stale.
    expect(() => toCalcVersionFromColumn(0)).toThrow(MalformedIdError);
    expect(() => toCalcVersionFromColumn(-1)).toThrow(MalformedIdError);
    expect(() => toCalcVersionFromColumn(1.5)).toThrow(MalformedIdError);
  });
});

describe('text column to a domain enum', () => {
  it('narrows a value the CHECK constraint allows', () => {
    expect(toEnumFromColumn('merchant_manual', COST_SOURCES, 'cost_history.source')).toBe('merchant_manual');
  });

  it('throws on a value outside the enum rather than casting it', () => {
    // This is the branch that exists because "should never happen" plus a cast
    // is how an unexpected value reaches an exhaustive switch with no arm for
    // it — and there it becomes a wrong number instead of an error.
    expect(() => toEnumFromColumn('vibes', COST_SOURCES, 'cost_history.source')).toThrow(
      /cost_history\.source holds "vibes"/,
    );
  });

  it('says which constraint should have stopped it, because that is the real defect', () => {
    let caught: unknown;
    try {
      toEnumFromColumn('vibes', COST_SOURCES, 'cost_history.source');
    } catch (error) {
      caught = error;
    }
    expect((caught as Error).message).toContain('CHECK constraint');
    // The allowed set belongs in the message: the reader needs to know what the
    // column was supposed to hold, not only what it held.
    expect((caught as Error).message).toContain(COST_SOURCES.join(', '));
  });
});
