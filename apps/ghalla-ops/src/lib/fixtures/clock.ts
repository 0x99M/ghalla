import { toInstant } from '@ghalla/contracts';
import type { Instant } from '@ghalla/contracts';

/**
 * One frozen moment, shared by every fixture.
 *
 * 14:24 in Asia/Amman, which is where the operator is — the same wall clock the
 * handoff's own screens are drawn at. Fixed rather than `new Date()` for two
 * reasons: a moving clock makes "updated 0s ago" the permanent answer and hides
 * the staleness bug the stamp exists to catch, and a store that is "silent for
 * 31 hours" has to STAY 31 hours silent or the health derivation flips between
 * renders and the fixtures stop demonstrating the states they were built for.
 */
export const FIXTURE_NOW = new Date('2026-09-05T11:24:00.000Z');
export const FIXTURE_NOW_INSTANT: Instant = toInstant(FIXTURE_NOW.toISOString());

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** `ago(3, 'h')` — readable offsets, so a fixture row states its own intent. */
export function ago(amount: number, unit: 's' | 'm' | 'h' | 'd'): Instant {
  const ms = { s: 1000, m: MINUTE, h: HOUR, d: DAY }[unit] * amount;
  return toInstant(new Date(FIXTURE_NOW.getTime() - ms).toISOString());
}

export function ahead(amount: number, unit: 's' | 'm' | 'h' | 'd'): Instant {
  const ms = { s: 1000, m: MINUTE, h: HOUR, d: DAY }[unit] * amount;
  return toInstant(new Date(FIXTURE_NOW.getTime() + ms).toISOString());
}
