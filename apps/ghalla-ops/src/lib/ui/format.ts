/**
 * Every figure this console prints, formatted in one place.
 *
 * The rules here are product decisions, not presentation trivia, which is why
 * they are functions with tests rather than template literals in components:
 * a coverage of `null` must never render as `0%`, an unknown timestamp must
 * never render as 1970, and a store's timezone must never be silently swapped
 * for the operator's. Each of those is a wrong number that looks like a right
 * one.
 */

/** The operator. Stated once, and always LABELLED wherever a time is shown. */
export const OPERATOR_TIME_ZONE = 'Asia/Amman';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Compact elapsed time: `40s`, `12m`, `31h`, `11d`.
 *
 * No "ago" — callers that need the word add it, because the store table's
 * "last webhook" column reads as a duration and the alert feed reads as a
 * sentence, and one of them would have to strip it back off.
 *
 * A FUTURE instant clamps to `now` rather than producing `-3m`. Clock skew
 * between the portal and an integration database is real and small, and a
 * negative age on a screen is read as a bug in the data rather than a fraction
 * of a second of drift.
 *
 * Hours run to 48 before switching to days, so "yesterday evening" stays
 * legible as `31h` instead of collapsing to a `1d` that could mean anything
 * from 24 to 47 hours — on the silent-store alert, that distinction is the
 * whole signal.
 */
export function relativeTime(iso: string, now: Date): string {
  const elapsed = now.getTime() - new Date(iso).getTime();
  if (Number.isNaN(elapsed)) return '—';
  if (elapsed <= 0) return 'now';
  if (elapsed < MINUTE) return `${String(Math.floor(elapsed / SECOND))}s`;
  if (elapsed < HOUR) return `${String(Math.floor(elapsed / MINUTE))}m`;
  if (elapsed < 2 * DAY) return `${String(Math.floor(elapsed / HOUR))}h`;
  return `${String(Math.floor(elapsed / DAY))}d`;
}

/** `relativeTime`, with the one answer a missing timestamp deserves. */
export function relativeTimeOrNever(iso: string | null, now: Date): string {
  return iso === null ? 'never' : relativeTime(iso, now);
}

const ABSOLUTE = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  const cached = ABSOLUTE.get(timeZone);
  if (cached !== undefined) return cached;
  const made = new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone,
  });
  ABSOLUTE.set(timeZone, made);
  return made;
}

/**
 * The hover text behind every relative timestamp: `5 Sep 2026, 14:20 Asia/Amman`.
 *
 * The zone is part of the STRING, never a separate field somebody can forget to
 * render. Stores sit in Gulf timezones and the operator sits in Amman, an hour
 * behind; an unlabelled "14:20" is ambiguous by exactly the amount that makes
 * an incident timeline wrong.
 */
export function absoluteTime(iso: string, timeZone: string = OPERATOR_TIME_ZONE): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'unknown';
  return `${formatter(timeZone).format(date).replace(',', ',')} ${timeZone}`;
}

/** Both forms at once, for a `<time>` with a `title`. */
export interface Stamp {
  readonly relative: string;
  readonly absolute: string;
}

export function stamp(iso: string | null, now: Date, timeZone?: string): Stamp {
  if (iso === null) return { relative: 'never', absolute: 'no event recorded' };
  return { relative: relativeTime(iso, now), absolute: absoluteTime(iso, timeZone) };
}

/** The em dash this console uses for "no value". One character, one meaning, one place. */
export const NO_VALUE = '—';

/**
 * Basis points as a percentage.
 *
 * `null` renders as the em dash and NEVER as `0%`. The distinction is the
 * reason coverage is nullable at all: a store with no revenue in the window has
 * unknown coverage, and painting it 0% puts a healthy quiet store at the top of
 * the "worst coverage" list while hiding a real one.
 */
export function bpsToPercent(bps: number | null, fractionDigits = 0): string {
  if (bps === null) return NO_VALUE;
  return `${(bps / 100).toFixed(fractionDigits)}%`;
}

const COUNT = new Intl.NumberFormat('en-US');

/** `4182` → `4,182`. Grouped, because these are read down a column and compared by width. */
export function count(value: number): string {
  return COUNT.format(value);
}

const MONEY = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

/**
 * Halalas to whole riyals: `1_290_000` → `12,900`.
 *
 * No currency symbol and no decimals. SAR is stated once per context per the
 * spec, and halalas on an MRR figure are noise — the number is a rounded
 * monthly rate to begin with, so two decimal places would imply a precision the
 * figure does not have.
 */
export function minorToRiyals(minor: number): string {
  return MONEY.format(Math.round(minor / 100));
}

/** Halalas to riyals with halalas kept, for anything that must reconcile. */
export function minorToRiyalsExact(minor: number): string {
  return (minor / 100).toFixed(2);
}

/**
 * A share as a whole percent, clamped for the BAR only — never for the label.
 *
 * A store at 112% of its cap must read `112%` in text, because that number is
 * the reason somebody is looking at the row. The bar is what gets clamped, and
 * it is clamped because a 112%-wide div overflows its track and looks like a
 * rendering fault rather than an overage.
 */
export function percentOf(used: number, allowed: number | null): number | null {
  if (allowed === null || allowed <= 0) return null;
  return Math.round((used / allowed) * 100);
}

export function clampBarWidth(percent: number): string {
  return `${String(Math.max(0, Math.min(percent, 100)))}%`;
}
