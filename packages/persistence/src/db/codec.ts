import { idFromString, toBps, toCalcVersion, toInstant, toLocalDate } from '@ghalla/contracts';
import type { Bps, CalcVersion, Id, Instant, LocalDate } from '@ghalla/contracts';

/**
 * Row values in, domain values out.
 *
 * The `pg` driver hands back a `Date` for `timestamptz` and a plain string for
 * `date`. The domain uses branded ISO strings for both, because the pure engine
 * is forbidden from `Date` entirely — `new Date()` is an ambient clock, and a
 * `Date` does not survive the JSON round trip the golden fixtures depend on.
 *
 * Persistence is not the pure layer, so it may hold a `Date`. It just may not
 * let one escape.
 */

/** `Date` → the canonical `YYYY-MM-DDTHH:mm:ss.sssZ`. */
export function toInstantFromDate(value: Date): Instant {
  return toInstant(value.toISOString());
}

export function toInstantFromDateOrNull(value: Date | null): Instant | null {
  return value === null ? null : toInstantFromDate(value);
}

/** The inverse. Postgres stores UTC either way; the column is `timestamptz` so it says so. */
export function toDateFromInstant(value: Instant): Date {
  return new Date(value);
}

export function toDateFromInstantOrNull(value: Instant | null): Date | null {
  return value === null ? null : toDateFromInstant(value);
}

/** A `date` column with `mode: 'string'` already returns `YYYY-MM-DD`; this validates it. */
export function toLocalDateFromColumn(value: string): LocalDate {
  return toLocalDate(value);
}

export function toIdFromColumn<T extends string>(value: string): Id<T> {
  return idFromString<T>(value);
}

export function toIdFromColumnOrNull<T extends string>(value: string | null): Id<T> | null {
  return value === null ? null : idFromString<T>(value);
}

export function toBpsFromColumn(value: number): Bps {
  return toBps(value);
}

export function toBpsFromColumnOrNull(value: number | null): Bps | null {
  return value === null ? null : toBps(value);
}

export function toCalcVersionFromColumn(value: number): CalcVersion {
  return toCalcVersion(value);
}

/**
 * Narrows a text column to one of a domain enum's members.
 *
 * The database has a CHECK constraint for the same set, so this should never
 * throw — but "should never" plus a cast is how a value nobody expected reaches
 * an exhaustive switch that has no branch for it.
 */
export function toEnumFromColumn<T extends string>(value: string, allowed: readonly T[], column: string): T {
  if (!(allowed as readonly string[]).includes(value)) {
    throw new Error(
      `${column} holds ${JSON.stringify(value)}, which is not one of ${allowed.join(', ')}. ` +
        `The CHECK constraint that should have prevented this is missing or was dropped.`,
    );
  }
  return value as T;
}
