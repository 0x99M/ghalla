import { describe, expect, it } from 'vitest';
import { aggregateRow, toInstantFromAggregate } from '../src/lib/queries/row';

describe('toInstantFromAggregate', () => {
  it('accepts a Date, which is what node-postgres builds from the type OID', () => {
    expect(toInstantFromAggregate(new Date('2026-09-05T12:00:00.000Z'))).toBe('2026-09-05T12:00:00.000Z');
  });

  it('accepts a string, which is what PGlite hands back for the same column', () => {
    // The ORM cannot type an aggregate expression, so what arrives is whatever
    // the driver decided. Assuming either one works in one place and throws in
    // the other, and this was found the second way round.
    expect(toInstantFromAggregate('2026-09-05 12:00:00+00')).toBe('2026-09-05T12:00:00.000Z');
  });

  it('is null for an absent value, because min() over nothing is legitimately absent', () => {
    expect(toInstantFromAggregate(null)).toBeNull();
    expect(toInstantFromAggregate(undefined)).toBeNull();
  });

  it('is null rather than a throw for something unusable', () => {
    // An operator page should not 500 because one aggregate came back in an
    // unexpected shape.
    expect(toInstantFromAggregate(12_345)).toBeNull();
    expect(toInstantFromAggregate('not a date')).toBeNull();
  });
});

describe('aggregateRow', () => {
  it('returns the row an aggregate always produces', () => {
    expect(aggregateRow([{ n: 7 }], { n: 0 })).toEqual({ n: 7 });
  });

  it('falls back for the case Postgres never produces', () => {
    // Collected here so the impossible case exists once, is named, and is
    // tested — rather than being an untested branch in nine different files.
    expect(aggregateRow([], { n: 0 })).toEqual({ n: 0 });
  });
});
