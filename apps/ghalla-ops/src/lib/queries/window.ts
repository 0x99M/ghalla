import { toLocalDateFromColumn } from '@ghalla/persistence/codec';
import { toInstant } from '@ghalla/contracts';
import type { Instant, LocalDate } from '@ghalla/contracts';

/**
 * The time ranges every query is asked for, defined once.
 *
 * Two kinds, and they are not interchangeable. A DATE window is over
 * `business_date`, which is store-local and is how the merchant's own dashboard
 * buckets a day — Riyadh is UTC+3 and volume skews late, so UTC bucketing files
 * every order after 21:00 under tomorrow. An INSTANT window is over a
 * `timestamptz`, which is a real moment and has no timezone opinion.
 *
 * Both are HALF-OPEN, `[from, to)`, for the reason `usageWindow` is: a closed
 * interval counts the boundary row in two adjacent buckets, and the two
 * adjacent buckets are usually two different periods a merchant is billed for.
 *
 * A caveat that has to be said out loud rather than hidden: a date window
 * compared against `business_date` is only approximately a wall-clock range
 * when stores span timezones, because each store's day boundary is its own.
 * That is the right trade for an operator view — the alternative is a per-store
 * offset in every aggregate — but it means "the last 30 days" can differ by a
 * few hours between two stores. It is never used for anything a merchant is
 * billed on; metering uses instants.
 */

export interface DateWindow {
  readonly from: LocalDate;
  readonly to: LocalDate;
}

export interface InstantWindow {
  readonly from: Instant;
  readonly to: Instant;
}

/** The ranges the API accepts. Named rather than free-form so a chart cannot ask for 400 days. */
export const RANGES = ['24h', '7d', '30d', '90d'] as const;
export type Range = (typeof RANGES)[number];

export const RANGE_DAYS: Readonly<Record<Range, number>> = {
  '24h': 1,
  '7d': 7,
  '30d': 30,
  '90d': 90,
};

export function isRange(value: string): value is Range {
  return (RANGES as readonly string[]).includes(value);
}

/** Coverage is defined over a trailing 30 days. The number lives here, not in a query. */
export const COVERAGE_DAYS = 30;

function toBusinessDate(value: Date): LocalDate {
  // `toISOString` then slice: the column is UTC-formatted `YYYY-MM-DD` and the
  // codec's constructor is what validates that shape, so the branding is a
  // check rather than a cast.
  return toLocalDateFromColumn(value.toISOString().slice(0, 10));
}

/**
 * `days` business dates ending with TODAY inclusive.
 *
 * Today is included rather than excluded: an operator looking at coverage wants
 * to know whether it is bad right now, and a window that stops at midnight
 * hides the morning in which something broke. The exclusive end is therefore
 * tomorrow.
 */
export function trailingDays(days: number, now: Date): DateWindow {
  const end = new Date(now.getTime());
  end.setUTCDate(end.getUTCDate() + 1);
  const start = new Date(end.getTime());
  start.setUTCDate(start.getUTCDate() - days);
  return { from: toBusinessDate(start), to: toBusinessDate(end) };
}

export function trailingHours(hours: number, now: Date): InstantWindow {
  return {
    from: toInstant(new Date(now.getTime() - hours * 3_600_000).toISOString()),
    to: toInstant(now.toISOString()),
  };
}

export function rangeToDateWindow(range: Range, now: Date): DateWindow {
  return trailingDays(RANGE_DAYS[range], now);
}

export function rangeToInstantWindow(range: Range, now: Date): InstantWindow {
  return trailingHours(RANGE_DAYS[range] * 24, now);
}

/** 24 hours. The silent-store threshold, the ingestion window, and the ack lifetime. */
export const DAY_MS = 24 * 60 * 60 * 1000;
