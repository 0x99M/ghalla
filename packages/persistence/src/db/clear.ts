import process from 'node:process';
import { sql } from 'drizzle-orm';
import { createDb, createPool } from './pool.js';
import type { Database } from './pool.js';

/**
 * Empties every table, for the clear → seed → test cycle before a release.
 *
 * TRUNCATE ... CASCADE in one statement rather than a delete per table: it
 * ignores foreign-key ordering, which would otherwise have to be maintained by
 * hand in the same order as the schema and would silently rot the first time a
 * table is added.
 */
export const PROTECTED_ENVIRONMENTS = ['production', 'prod'];

export class RefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RefusedError';
  }
}

export interface ClearOptions {
  readonly environmentName: string | undefined;
  readonly confirmed: boolean;
}

/**
 * Two independent guards, because one is not enough for a command whose whole
 * job is to destroy data.
 *
 * The environment check catches the ordinary accident — a shell that still has
 * production credentials exported from an hour ago. The explicit confirmation
 * catches the other one: a script that runs this without anybody deciding to.
 */
export function assertClearIsAllowed(options: ClearOptions): void {
  const environment = options.environmentName?.toLowerCase() ?? '';
  if (PROTECTED_ENVIRONMENTS.includes(environment)) {
    throw new RefusedError(
      `Refusing to clear the ${environment} database. This command exists for staging and local ` +
        `development; production data is restored from a backup, not re-seeded.`,
    );
  }
  if (!options.confirmed) {
    throw new RefusedError(
      'Refusing to clear without explicit confirmation. Set GHALLA_ALLOW_DESTRUCTIVE=1 to proceed.',
    );
  }
}

/** Every table drizzle-kit created, minus its own bookkeeping. */
export async function listTables(db: Database): Promise<readonly string[]> {
  const result = await db.execute<{ tablename: string }>(sql`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename NOT LIKE '__drizzle%'
    ORDER BY tablename
  `);
  const rows = Array.isArray(result) ? result : ((result as { rows: { tablename: string }[] }).rows ?? []);
  return rows.map((row) => row.tablename);
}

export async function clearAll(db: Database): Promise<readonly string[]> {
  const tables = await listTables(db);
  if (tables.length === 0) return [];
  const list = tables.map((t) => `"${t}"`).join(', ');
  // RESTART IDENTITY so a re-seed produces the same ids as a fresh database,
  // which is what makes a seeded environment reproducible rather than merely
  // empty.
  await db.execute(sql.raw(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`));
  return tables;
}

async function main(): Promise<void> {
  const databaseUrl = process.env['DATABASE_URL'];
  if (databaseUrl === undefined || databaseUrl === '') throw new Error('DATABASE_URL is not defined');

  assertClearIsAllowed({
    environmentName: process.env['RAILWAY_ENVIRONMENT_NAME'] ?? process.env['NODE_ENV'],
    confirmed: process.env['GHALLA_ALLOW_DESTRUCTIVE'] === '1',
  });

  const pool = createPool({ databaseUrl, max: 1 });
  try {
    const cleared = await clearAll(createDb(pool));
    console.log(`Cleared ${String(cleared.length)} tables: ${cleared.join(', ')}`);
  } finally {
    await pool.end();
  }
}

if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
