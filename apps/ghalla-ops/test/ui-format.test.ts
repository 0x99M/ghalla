import { describe, expect, it } from 'vitest';
import {
  NO_VALUE,
  absoluteTime,
  bpsToPercent,
  clampBarWidth,
  count,
  minorToRiyals,
  minorToRiyalsExact,
  percentOf,
  relativeTime,
  relativeTimeOrNever,
  stamp,
} from '../src/lib/ui/format';

const NOW = new Date('2026-09-05T14:24:00.000Z');
const ago = (ms: number): string => new Date(NOW.getTime() - ms).toISOString();

describe('relativeTime', () => {
  it('steps through seconds, minutes, hours and days', () => {
    expect(relativeTime(ago(40_000), NOW)).toBe('40s');
    expect(relativeTime(ago(12 * 60_000), NOW)).toBe('12m');
    expect(relativeTime(ago(31 * 3_600_000), NOW)).toBe('31h');
    expect(relativeTime(ago(11 * 86_400_000), NOW)).toBe('11d');
  });

  it('holds hours to 48 before switching to days', () => {
    // The silent-store signal is "no webhook for a day or more", and `1d`
    // could mean anything from 24 to 47 hours. `31h` is the number that tells
    // an operator whether this started before or after last night.
    expect(relativeTime(ago(47 * 3_600_000), NOW)).toBe('47h');
    expect(relativeTime(ago(48 * 3_600_000), NOW)).toBe('2d');
  });

  it('clamps a future instant instead of printing a negative age', () => {
    expect(relativeTime(new Date(NOW.getTime() + 5_000).toISOString(), NOW)).toBe('now');
  });

  it('answers an unparseable instant with the em dash', () => {
    expect(relativeTime('not a date', NOW)).toBe(NO_VALUE);
  });

  it('distinguishes never from now', () => {
    expect(relativeTimeOrNever(null, NOW)).toBe('never');
    expect(relativeTimeOrNever(ago(1000), NOW)).toBe('1s');
  });
});

describe('absoluteTime', () => {
  it('always carries the zone in the string', () => {
    const text = absoluteTime('2026-09-05T11:24:00.000Z');
    expect(text).toContain('Asia/Amman');
    // Amman is UTC+3 in September.
    expect(text).toContain('14:24');
  });

  it('renders a store in its own zone when asked', () => {
    const text = absoluteTime('2026-09-05T11:24:00.000Z', 'Asia/Riyadh');
    expect(text).toContain('Asia/Riyadh');
    expect(text).toContain('14:24');
  });

  it('says so rather than falling back to 1970', () => {
    expect(absoluteTime('nonsense')).toBe('unknown');
  });
});

describe('stamp', () => {
  it('pairs the relative and absolute forms', () => {
    expect(stamp(ago(3_600_000), NOW)).toStrictEqual({
      relative: '1h',
      absolute: absoluteTime(ago(3_600_000)),
    });
  });

  it('has one answer for a missing instant', () => {
    expect(stamp(null, NOW)).toStrictEqual({ relative: 'never', absolute: 'no event recorded' });
  });
});

describe('bpsToPercent', () => {
  it('converts basis points', () => {
    expect(bpsToPercent(9_200)).toBe('92%');
    expect(bpsToPercent(0)).toBe('0%');
    expect(bpsToPercent(10_000)).toBe('100%');
  });

  it('keeps unknown distinct from zero', () => {
    // A store with no revenue has unknown coverage, not bad coverage. Rendering
    // it as 0% puts a quiet healthy store at the top of the worst-coverage list.
    expect(bpsToPercent(null)).toBe(NO_VALUE);
  });

  it('takes fraction digits where a rate needs them', () => {
    expect(bpsToPercent(9_170, 1)).toBe('91.7%');
  });
});

describe('money and counts', () => {
  it('groups counts', () => {
    expect(count(4_182)).toBe('4,182');
    expect(count(0)).toBe('0');
  });

  it('renders halalas as whole riyals', () => {
    expect(minorToRiyals(1_290_000)).toBe('12,900');
    expect(minorToRiyals(24_900)).toBe('249');
  });

  it('keeps halalas where a figure must reconcile', () => {
    expect(minorToRiyalsExact(12_945)).toBe('129.45');
  });
});

describe('percentOf and clampBarWidth', () => {
  it('reports an overage truthfully', () => {
    expect(percentOf(336, 300)).toBe(112);
  });

  it('has no percentage against an unlimited cap', () => {
    expect(percentOf(9_000, null)).toBeNull();
    expect(percentOf(9_000, 0)).toBeNull();
  });

  it('clamps the BAR but never the label', () => {
    // 112% is the number that explains why somebody opened the row; a 112%-wide
    // div is a rendering fault.
    expect(clampBarWidth(112)).toBe('100%');
    expect(clampBarWidth(61)).toBe('61%');
    expect(clampBarWidth(-4)).toBe('0%');
  });
});
