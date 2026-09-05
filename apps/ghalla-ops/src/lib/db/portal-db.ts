import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { createPool } from '@ghalla/persistence/pool';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { loadPortalConfig } from '../platforms/config';
import * as portalSchema from './portal-schema';

/**
 * The portal's own database — the ONE the portal may write to.
 *
 * Held on `globalThis` for the same reason as the platform registry: Next
 * re-evaluates modules on hot reload, and a module-level singleton would open a
 * pool per edit.
 */

/**
 * The driver-agnostic handle, not `NodePgDatabase`, for the same reason
 * `@ghalla/persistence` widens its own: production runs on `pg` and the tests
 * run the SAME migrations and the SAME writes against PGlite. Pinning the
 * concrete driver would make those tests impossible to type-check, which is how
 * a suite ends up asserting against a mock instead of a database.
 */
export type PortalDatabase = PgDatabase<PgQueryResultHKT, typeof portalSchema>;

const PORTAL_DB_KEY = Symbol.for('ghalla.ops.portalDb');

interface PortalHolder {
  [PORTAL_DB_KEY]?: PortalDatabase;
}

export function getPortalDb(): PortalDatabase {
  const holder = globalThis as PortalHolder;
  const existing = holder[PORTAL_DB_KEY];
  if (existing !== undefined) return existing;

  const config = loadPortalConfig(process.env);
  const pool = createPool({
    databaseUrl: config.databaseUrl,
    // Larger than an integration pool: this one is nobody else's resource.
    max: 5,
    statementTimeoutMs: 10_000,
    queryTimeoutMs: 15_000,
    applicationName: 'ghalla-ops:portal',
  });
  const db = drizzle({ client: pool, schema: portalSchema });
  holder[PORTAL_DB_KEY] = db;
  return db;
}

/** Cheapest possible round trip, for the health check. */
export async function pingPortalDb(db: PortalDatabase): Promise<void> {
  await db.execute(sql`select 1`);
}
