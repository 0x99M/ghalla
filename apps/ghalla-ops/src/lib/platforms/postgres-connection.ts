import { createDb, createPool } from '@ghalla/persistence/pool';
import { asReadOnly } from './read-only';
import { PROBE_SQL, toProbe } from './registry';
import type { PlatformConnection, PlatformProbe } from './registry';
import type { PlatformConfig } from './config';

/**
 * The real Postgres connection behind a `PlatformHandle`.
 *
 * Separated from the registry because it is process wiring: a pool, a driver
 * and a cast, none of which a unit test can exercise without a server. The
 * behaviour worth testing — what a probe MEANS — is `evaluateProbe`, which is
 * pure and lives next door. This file is covered by the staging smoke test.
 */

/**
 * Small on purpose.
 *
 * The portal is one operator. The integration service is serving every
 * merchant, and connections are the resource they are both drawing on — so a
 * dashboard that opens ten of them to render a chart is taking them from the
 * people who are paying.
 */
export const DEFAULT_POOL_MAX = 3;
/** Server-side. A query that plans badly gets killed rather than parked on a connection. */
export const DEFAULT_STATEMENT_TIMEOUT_MS = 5_000;
/** Client-side, and deliberately longer: it exists for a server that stopped answering at all. */
export const DEFAULT_QUERY_TIMEOUT_MS = 8_000;
export const DEFAULT_CONNECTION_TIMEOUT_MS = 5_000;

export function createPostgresConnection(config: PlatformConfig): PlatformConnection {
  const pool = createPool({
    databaseUrl: config.databaseUrl,
    max: DEFAULT_POOL_MAX,
    statementTimeoutMs: DEFAULT_STATEMENT_TIMEOUT_MS,
    queryTimeoutMs: DEFAULT_QUERY_TIMEOUT_MS,
    connectionTimeoutMs: DEFAULT_CONNECTION_TIMEOUT_MS,
    // Shows in pg_stat_activity, so an operator looking at a busy integration
    // database can tell which of its connections belong to the portal.
    applicationName: `ghalla-ops:${config.platform}`,
  });

  return {
    db: asReadOnly(createDb(pool)),
    async probe(): Promise<PlatformProbe> {
      const result = await pool.query(PROBE_SQL);
      const row: unknown = result.rows[0];
      if (row === undefined) throw new Error('the connection probe returned no rows');
      return toProbe(row);
    },
    async close(): Promise<void> {
      await pool.end();
    },
  };
}
