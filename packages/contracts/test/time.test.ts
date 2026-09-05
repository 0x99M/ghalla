import { describe, expect, it } from 'vitest';
import { MalformedTimestampError, isInstant, toInstant, toLocalDate } from '../src/time.js';

describe('toInstant', () => {
  it('accepts a UTC instant with milliseconds', () => {
    expect(toInstant('2026-09-05T18:30:00.000Z')).toBe('2026-09-05T18:30:00.000Z');
  });

  it('rejects an offset form, so no comparison anywhere has to remember to normalize', () => {
    expect(() => toInstant('2026-09-05T21:30:00.000+03:00')).toThrow(MalformedTimestampError);
  });

  it.each(['2026-09-05T18:30:00Z', '2026-09-05 18:30:00.000Z', '2026-09-05'])(
    'rejects the loose form %s',
    (raw) => {
      expect(() => toInstant(raw)).toThrow(MalformedTimestampError);
    },
  );

  it('rejects a date that does not exist, where new Date() would silently roll over to March', () => {
    expect(() => toInstant('2026-02-30T00:00:00.000Z')).toThrow(MalformedTimestampError);
    expect(isInstant('2026-02-30T00:00:00.000Z')).toBe(false);
  });

  it('rejects an impossible time of day', () => {
    expect(() => toInstant('2026-09-05T24:00:00.000Z')).toThrow(MalformedTimestampError);
  });
});

describe('toLocalDate', () => {
  it('applies the full leap-year rule, not the divisible-by-four approximation', () => {
    expect(toLocalDate('2028-02-29')).toBe('2028-02-29');
    expect(() => toLocalDate('2027-02-29')).toThrow(MalformedTimestampError);
    expect(() => toLocalDate('2100-02-29')).toThrow(MalformedTimestampError);
    expect(toLocalDate('2000-02-29')).toBe('2000-02-29');
  });
});
