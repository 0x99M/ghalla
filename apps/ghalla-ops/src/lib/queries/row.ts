import { toInstant } from '@ghalla/contracts';
import { toInstantFromDate } from '@ghalla/persistence/codec';
import type { Instant } from '@ghalla/contracts';

/**
 * A timestamp that came out of an AGGREGATE, where the ORM cannot know its type.
 *
 * `select ts from t` is typed, and Drizzle hands back a `Date`. `select max(ts)`
 * inside a raw SQL template is not: Drizzle has no column to map, so what
 * arrives is whatever the driver decided — `pg` builds a `Date` from the type
 * OID, PGlite hands back the string. Code that assumes one of those works in
 * the tests and throws in production, or the other way round, and this was
 * found the second way round.
 *
 * So both are accepted, and an unparseable value is `null` rather than a throw:
 * a `min(...)` over an empty set is legitimately absent, and an operator page
 * should not 500 because one aggregate came back in an unexpected shape.
 */
export function toInstantFromAggregate(value: unknown): Instant | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return toInstantFromDate(value);
  if (typeof value !== 'string') return null;

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : toInstant(parsed.toISOString());
}

/**
 * The one row an aggregate without `GROUP BY` always returns.
 *
 * Postgres guarantees exactly one, so the fallback cannot be reached through
 * any query in this codebase — but `noUncheckedIndexedAccess` is on and
 * asserting it away would be a lie in the one place a lie is cheapest to tell.
 * Collected here so the impossible case exists ONCE, is named, and is tested
 * directly rather than being an untested branch in nine different files.
 */
export function aggregateRow<T>(rows: readonly T[], empty: T): T {
  return rows[0] ?? empty;
}
