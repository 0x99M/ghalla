import { toLocalDate } from '@ghalla/contracts';
import type { Instant, LocalDate } from '@ghalla/contracts';

/**
 * The store-local calendar date an order belongs to.
 *
 * Store-local, not UTC. Riyadh is UTC+3 and Saudi order volume skews to late
 * evening, so UTC bucketing pushes every order after 21:00 local into the next
 * day — and Ghalla's "yesterday" would disagree with the merchant's own
 * dashboard every single day.
 *
 * Implemented without `Date`, which the pure layer bans outright. The civil-day
 * arithmetic below is Howard Hinnant's algorithm; `Intl` then does the zone
 * conversion. `Intl` is an ambient ES builtin rather than a dependency, and it
 * reads no clock: given the same instant and zone it returns the same date
 * forever, which is all purity asks of it.
 */
export class InvalidTimezoneError extends Error {
  constructor(timezone: string) {
    super(`Unknown IANA time zone: ${JSON.stringify(timezone)}.`);
    this.name = 'InvalidTimezoneError';
  }
}

const INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{3})Z$/;

/** Days since 1970-01-01 from a proleptic Gregorian civil date. */
function daysFromCivil(year: number, month: number, day: number): number {
  const y = year - (month <= 2 ? 1 : 0);
  const era = Math.floor(y / 400);
  const yearOfEra = y - era * 400;
  const dayOfYear = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const dayOfEra = yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  return era * 146_097 + dayOfEra - 719_468;
}

export function epochMillis(instant: Instant): number {
  const match = INSTANT.exec(instant);
  if (match === null) {
    throw new InvalidTimezoneError(`unparseable instant ${String(instant)}`);
  }
  const [, y = '', mo = '', d = '', h = '', mi = '', s = '', ms = ''] = match;
  return (
    daysFromCivil(Number(y), Number(mo), Number(d)) * 86_400_000 +
    Number(h) * 3_600_000 +
    Number(mi) * 60_000 +
    Number(s) * 1_000 +
    Number(ms)
  );
}

export function businessDateOf(instant: Instant, timezone: string): LocalDate {
  let parts: readonly Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(epochMillis(instant));
  } catch {
    throw new InvalidTimezoneError(timezone);
  }
  const find = (type: string): string => parts.find((part) => part.type === type)?.value ?? '';
  return toLocalDate(`${find('year').padStart(4, '0')}-${find('month')}-${find('day')}`);
}
