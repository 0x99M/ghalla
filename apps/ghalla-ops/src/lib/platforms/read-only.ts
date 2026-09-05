import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import type * as schema from '@ghalla/persistence/schema';

/**
 * The integration's handle, as `@ghalla/persistence` defines it. Present only so
 * the narrow type below can be carved out of it.
 */
type IntegrationDatabase = PgDatabase<PgQueryResultHKT, typeof schema>;

/**
 * A handle on an integration database that can only read — boundary layer 2.
 *
 * `insert`, `update`, `delete`, `execute` and `transaction` are not on this
 * type, so `db.insert(orders)` inside the portal is a compile error rather than
 * a code review someone has to remember to do. `execute` is excluded with the
 * writes on purpose: it takes arbitrary SQL and would be the one hole big
 * enough to drive everything else through.
 *
 * This is a TYPE-level guard and nothing more — the object underneath is the
 * full Drizzle handle and a cast would defeat it. The guarantee lives in the
 * database, where `ghalla_ops_ro` holds SELECT on a named list of columns and
 * nothing else. The four layers, weakest to strongest:
 *
 *   1. this type            — the mistake does not compile
 *   2. `no-restricted-imports` — the write repositories cannot be imported
 *   3. dependency-cruiser   — and cannot be reached transitively either
 *   4. the Postgres role    — and if all three fail, the server refuses
 *
 * Only the fourth is a guarantee. The first three exist so the fourth is never
 * the thing that finds the bug.
 */
export type ReadOnlyDatabase = Pick<IntegrationDatabase, 'select'>;

/**
 * Names the boundary. Structurally the identity function, which is the point:
 * widening happens here, once, where it can be pointed at.
 */
export function asReadOnly(db: IntegrationDatabase): ReadOnlyDatabase {
  return db;
}
