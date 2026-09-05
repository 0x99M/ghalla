import { describe, expect, it } from 'vitest';
import {
  COVERAGE_DAYS,
  RANGES,
  isRange,
  rangeToDateWindow,
  rangeToInstantWindow,
  trailingDays,
  trailingHours,
} from '../src/lib/queries/window';

const NOW = new Date('2026-09-05T12:00:00.000Z');

describe('trailingDays', () => {
  it('includes today, so a morning outage is visible before midnight', () => {
    expect(trailingDays(30, NOW)).toEqual({ from: '2026-08-07', to: '2026-09-06' });
  });

  it('spans exactly the number of business dates asked for', () => {
    expect(trailingDays(1, NOW)).toEqual({ from: '2026-09-05', to: '2026-09-06' });
  });

  it('crosses a month and a year boundary correctly', () => {
    expect(trailingDays(7, new Date('2027-01-02T00:00:00.000Z'))).toEqual({
      from: '2026-12-27',
      to: '2027-01-03',
    });
  });

  it('does not mutate the date it was given', () => {
    const now = new Date('2026-09-05T12:00:00.000Z');
    trailingDays(30, now);
    expect(now.toISOString()).toBe('2026-09-05T12:00:00.000Z');
  });
});

describe('trailingHours', () => {
  it('is a half-open instant range ending now', () => {
    expect(trailingHours(24, NOW)).toEqual({
      from: '2026-09-04T12:00:00.000Z',
      to: '2026-09-05T12:00:00.000Z',
    });
  });
});

describe('ranges', () => {
  it('accepts only the named ranges, so a chart cannot ask for 400 days', () => {
    for (const range of RANGES) expect(isRange(range)).toBe(true);
    expect(isRange('400d')).toBe(false);
    expect(isRange('')).toBe(false);
  });

  it('maps a range to both kinds of window', () => {
    expect(rangeToDateWindow('7d', NOW)).toEqual({ from: '2026-08-30', to: '2026-09-06' });
    expect(rangeToInstantWindow('24h', NOW).from).toBe('2026-09-04T12:00:00.000Z');
  });

  it('fixes the coverage window at thirty days in one place', () => {
    expect(COVERAGE_DAYS).toBe(30);
  });
});
