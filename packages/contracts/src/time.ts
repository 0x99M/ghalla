import type { Brand } from './brand.js';

/**
 * An instant in time: exactly `YYYY-MM-DDTHH:mm:ss.sssZ`, UTC only.
 *
 * A string rather than a `Date` for two reasons that both bite. `Date` does not
 * survive `JSON.parse`, and the golden-fixture harness that guards the profit
 * engine is entirely JSON. And the engine is forbidden from `dayjs`/`luxon`, so
 * there would be no sanctioned way to manipulate a `Date` inside it anyway.
 *
 * Offset forms (`+03:00`) are rejected rather than normalized: accepting them
 * means every comparison in the system has to remember to normalize first, and
 * one that forgets is a silent three-hour error in a country that is UTC+3.
 */
export type Instant = Brand<string, 'Instant'>;

/**
 * A calendar date in the *store's* timezone: exactly `YYYY-MM-DD`.
 *
 * Store-local, not UTC. Asia/Riyadh is UTC+3 and Saudi order volume skews to
 * late evening, so UTC bucketing pushes every order after 21:00 local into the
 * next day — and Ghalla's "yesterday" would disagree with the merchant's own
 * dashboard every single day.
 */
export type LocalDate = Brand<string, 'LocalDate'>;

export class MalformedTimestampError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MalformedTimestampError';
  }
}

const INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{3})Z$/;
const LOCAL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/**
 * Calendar validity is checked arithmetically rather than by constructing a
 * `Date`. Keeping the pure layer free of `Date` entirely is what lets the
 * "no ambient clock" lint rule be an unqualified ban with no exceptions to
 * argue about — and `new Date('2026-02-30')` rolls over to March rather than
 * failing, which is exactly the wrong behaviour for a validator.
 */
function isRealDate(year: number, month: number, day: number): boolean {
  if (day < 1) return false;
  // The lookup IS the range check. Asking `month < 1 || month > 12` first and
  // then defaulting the subscript anyway asks the same question twice and
  // leaves the second answer untestable.
  const base = DAYS_IN_MONTH[month - 1];
  if (base === undefined) return false;
  const max = month === 2 && isLeapYear(year) ? 29 : base;
  return day <= max;
}

/** Non-throwing companion to `toInstant`, for validators that must report a field path. */
export function isInstant(raw: string): raw is Instant {
  const match = INSTANT.exec(raw);
  if (match === null) return false;
  const [, y = '', mo = '', d = '', h = '', mi = '', s = ''] = match;
  if (!isRealDate(Number(y), Number(mo), Number(d))) return false;
  return Number(h) <= 23 && Number(mi) <= 59 && Number(s) <= 59;
}

export function isLocalDate(raw: string): raw is LocalDate {
  const match = LOCAL_DATE.exec(raw);
  if (match === null) return false;
  const [, y = '', mo = '', d = ''] = match;
  return isRealDate(Number(y), Number(mo), Number(d));
}

export function toInstant(raw: string): Instant {
  const match = INSTANT.exec(raw);
  if (match === null) {
    throw new MalformedTimestampError(
      `Expected an ISO-8601 UTC instant of the form YYYY-MM-DDTHH:mm:ss.sssZ; received ${JSON.stringify(raw)}. ` +
        `Offsets are rejected: normalize to UTC in the adapter, where the platform's own convention is known.`,
    );
  }
  const [, y = '', mo = '', d = '', h = '', mi = '', s = ''] = match;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  if (!isRealDate(year, month, day)) {
    throw new MalformedTimestampError(`Not a real calendar date: ${JSON.stringify(raw)}.`);
  }
  if (Number(h) > 23 || Number(mi) > 59 || Number(s) > 59) {
    throw new MalformedTimestampError(`Not a real time of day: ${JSON.stringify(raw)}.`);
  }
  return raw as Instant;
}

export function toLocalDate(raw: string): LocalDate {
  const match = LOCAL_DATE.exec(raw);
  if (match === null) {
    throw new MalformedTimestampError(
      `Expected a calendar date of the form YYYY-MM-DD; received ${JSON.stringify(raw)}.`,
    );
  }
  const [, y = '', mo = '', d = ''] = match;
  if (!isRealDate(Number(y), Number(mo), Number(d))) {
    throw new MalformedTimestampError(`Not a real calendar date: ${JSON.stringify(raw)}.`);
  }
  return raw as LocalDate;
}
