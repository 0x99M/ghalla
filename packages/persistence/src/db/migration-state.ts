import fs from 'node:fs';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import type { Database } from './pool.js';

/**
 * Whether the database is at the migration level this build expects.
 *
 * The deploy applies migrations before the app starts, so in the ordinary case
 * this is always `current` and reports nothing interesting. It exists for the
 * case where it is not: a pre-deploy hook that was silently unset, a rollback
 * to an image older than the schema, a database swapped underneath the service.
 * Each of those produces a process that starts, answers, and returns wrong
 * numbers — which is the failure this whole codebase is arranged to prevent.
 *
 * Two sources, compared: the journal shipped in the image says what the CODE
 * expects, and `drizzle.__drizzle_migrations` says what the DATABASE has.
 */
export interface MigrationState {
  /** Migrations in the journal that shipped with this build. */
  readonly expected: number;
  /** Migrations recorded as applied in the database. */
  readonly applied: number;
  /** Newest tag the code knows about, for a log line that names something. */
  readonly latest: string | null;
  readonly status: 'current' | 'behind' | 'ahead' | 'unknown';
}

interface JournalEntry {
  readonly tag: string;
}

/**
 * Reads the tags drizzle-kit recorded, newest last.
 *
 * Returns an empty list rather than throwing when the journal is missing or
 * malformed: this is diagnostic code, and a health endpoint that dies trying to
 * report health is worse than one that says it does not know.
 */
export function readJournalTags(migrationsFolder: string): readonly string[] {
  try {
    const raw = fs.readFileSync(path.join(migrationsFolder, 'meta', '_journal.json'), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || !('entries' in parsed)) return [];
    const entries = (parsed as { entries: unknown }).entries;
    if (!Array.isArray(entries)) return [];
    return entries
      .filter((e): e is JournalEntry => typeof e === 'object' && e !== null && 'tag' in e)
      .map((e) => e.tag);
  } catch {
    return [];
  }
}

/**
 * Counts what the database says it has applied.
 *
 * `-1` for "could not tell", which is deliberately not `0`: a fresh database
 * with no migrations and an unreachable one are opposite problems, and
 * collapsing them would report a database that is merely down as one that is
 * catastrophically empty.
 */
export async function countAppliedMigrations(db: Database): Promise<number> {
  try {
    return extractCount(
      await db.execute(sql`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`),
    );
  } catch {
    // The table does not exist until the first migration runs, so this is also
    // the honest answer for a database nothing has ever migrated.
    return -1;
  }
}

/**
 * One row, one column, two driver shapes.
 *
 * `node-postgres` hands back a pg `Result` with a `rows` array; the PGlite
 * driver the schema tests run against hands back the array itself. The
 * repository type is deliberately the widened `PgDatabase` so both are
 * possible, which makes narrowing this the caller's job — and doing it in a
 * pure function is what lets both shapes be tested without a database.
 */
export function extractCount(result: unknown): number {
  const rows: readonly unknown[] = Array.isArray(result) ? result : rowsOf(result);
  const value = (rows[0] as { n?: unknown } | undefined)?.n;
  return typeof value === 'number' ? value : 0;
}

function rowsOf(result: unknown): readonly unknown[] {
  const rows = (result as { rows?: unknown } | null | undefined)?.rows;
  return Array.isArray(rows) ? rows : [];
}

export function compareMigrations(expectedTags: readonly string[], applied: number): MigrationState {
  const expected = expectedTags.length;
  const latest = expectedTags.at(-1) ?? null;
  if (applied < 0) return { expected, applied: 0, latest, status: 'unknown' };
  if (applied === expected) return { expected, applied, latest, status: 'current' };
  // `ahead` means the database has migrations this build has never heard of —
  // a rollback to an older image. Reported separately from `behind` because the
  // remedy is the opposite one, and because rolling forward again is safe while
  // "fixing" it by migrating is not.
  return { expected, applied, latest, status: applied > expected ? 'ahead' : 'behind' };
}

export async function readMigrationState(
  db: Database,
  migrationsFolder: string,
): Promise<MigrationState> {
  return compareMigrations(readJournalTags(migrationsFolder), await countAppliedMigrations(db));
}
