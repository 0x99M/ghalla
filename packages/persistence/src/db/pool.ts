import { drizzle } from 'drizzle-orm/node-postgres';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { Pool } from 'pg';
import * as schema from './schema.js';

/**
 * The driver-agnostic handle every repository takes.
 *
 * Deliberately the common base rather than `NodePgDatabase`: production runs on
 * `pg`, and the schema tests run the SAME migrations and the SAME repositories
 * against PGlite — Postgres compiled to WebAssembly, in this process. Pinning
 * the concrete driver type would make those tests impossible to type-check,
 * which is how a test suite ends up asserting against a mock instead of a
 * database.
 */
export type Database = PgDatabase<PgQueryResultHKT, typeof schema>;

export interface PoolConfig {
  readonly databaseUrl: string;
  /** `disable` | `require` | `verify-full` and the usual aliases. Explicit configuration always wins. */
  readonly sslMode?: string | undefined;
  readonly max?: number | undefined;
  readonly min?: number | undefined;
  readonly idleTimeoutMs?: number | undefined;
  readonly connectionTimeoutMs?: number | undefined;
  /**
   * Server-side cap on a single statement, in milliseconds.
   *
   * For the readers: an analytical query that plans badly must not sit holding
   * a connection the service serving merchants is waiting for. Postgres kills
   * it; the caller gets an error it can report rather than a page that hangs.
   */
  readonly statementTimeoutMs?: number | undefined;
  /**
   * Client-side cap, which is NOT the same guarantee.
   *
   * `statement_timeout` needs the server to still be talking to us. A server
   * that accepted the query and then stopped answering — a network partition,
   * a machine that went away mid-result — trips this one and nothing else.
   */
  readonly queryTimeoutMs?: number | undefined;
  /** Shows up in `pg_stat_activity`, so a heavy query can be attributed to a service by name. */
  readonly applicationName?: string | undefined;
}

/**
 * Managed providers terminate TLS with certificates we do not pin, while a local
 * Postgres usually speaks plaintext. Explicit configuration always wins; the
 * heuristic only fills the gap.
 *
 * The decision is made on the CONNECTION STRING, not on `NODE_ENV`. Whether the
 * database is somewhere else is a property of the address, and it is right
 * there — keying it on an environment variable means a preview deploy that
 * forgot to set one sends its credentials and every row it reads over the open
 * network, silently.
 *
 * `rejectUnauthorized: false` is a real limitation stated rather than hidden:
 * a self-signed provider certificate would otherwise refuse every connection.
 * This encrypts the transport and does not authenticate the server. Set
 * `sslMode: 'verify-full'` with a CA to get the other half — the branch below
 * already honours it.
 */
export function resolveSsl(config: PoolConfig): false | { rejectUnauthorized: boolean } {
  const mode = config.sslMode?.toLowerCase();
  if (mode !== undefined && mode !== '') {
    if (['disable', 'off', 'false', '0', 'no'].includes(mode)) return false;
    if (['require', 'true', 'on', 'prefer', 'no-verify'].includes(mode)) {
      return { rejectUnauthorized: false };
    }
    if (['verify-full', 'verify-ca', 'strict'].includes(mode)) return { rejectUnauthorized: true };
  }

  const isLocal = /@(localhost|127\.0\.0\.1|0\.0\.0\.0|db|postgres)(:|\/)/i.test(config.databaseUrl);
  return isLocal ? false : { rejectUnauthorized: false };
}

/**
 * `pg` emits `error` on the POOL when a client that is sitting idle fails — a
 * database restart, a connection reaped by a proxy, a network blip. An `error`
 * event with no listener is an uncaught exception in Node, so a pool without
 * one turns a routine idle-connection drop into a dead process.
 *
 * Logged rather than rethrown, and deliberately not `process.exit`: the pool
 * has already discarded the broken client and the next query opens a fresh one,
 * so the recoverable case recovers. What is not acceptable is that it happens
 * silently, because a service quietly cycling connections all night is
 * something an operator needs to be able to find in a log.
 */
function attachErrorListener(pool: Pool, label: string | undefined): void {
  pool.on('error', (error: Error) => {
    console.error(
      `[pg] idle client error${label === undefined ? '' : ` (${label})`}: ${error.message}`,
      error.stack,
    );
  });
}

export function createPool(config: PoolConfig): Pool {
  const pool = new Pool({
    connectionString: config.databaseUrl,
    ssl: resolveSsl(config),
    max: config.max ?? 10,
    min: config.min ?? 0,
    idleTimeoutMillis: config.idleTimeoutMs ?? 30_000,
    connectionTimeoutMillis: config.connectionTimeoutMs ?? 10_000,
    // Spread rather than passed as `undefined`: `exactOptionalPropertyTypes`
    // distinguishes an absent option from one explicitly set to undefined, and
    // node-postgres reads `0` as "no timeout" — so a stray undefined would be a
    // type error here and a silently disabled timeout if it were coerced.
    ...(config.statementTimeoutMs === undefined ? {} : { statement_timeout: config.statementTimeoutMs }),
    ...(config.queryTimeoutMs === undefined ? {} : { query_timeout: config.queryTimeoutMs }),
    ...(config.applicationName === undefined ? {} : { application_name: config.applicationName }),
  });
  attachErrorListener(pool, config.applicationName);
  return pool;
}

/**
 * Returns the CONCRETE node-postgres handle, not the widened one — the migrator
 * needs the driver it was built for. It is assignable to `Database` wherever a
 * repository wants it.
 */
export function createDb(pool: Pool): NodePgDatabase<typeof schema> {
  return drizzle({ client: pool, schema });
}
