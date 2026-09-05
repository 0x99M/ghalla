import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDb, createPool } from './pool.js';

/**
 * Production migration runner.
 *
 * Railway's pre-deploy hook calls this through `migrate:deploy`, which runs the
 * COMPILED output — so drizzle-kit stays a devDependency and never has to
 * survive into the runtime image.
 *
 * Each platform's service owns the migrations for its OWN database. They share
 * this schema file, not a database, so the same migration set is applied
 * separately per deployment.
 */
export async function runMigrations(databaseUrl: string, migrationsFolder: string): Promise<void> {
  // max: 1 — a migration is a single serialized conversation, and a pool would
  // let a second connection wait on a lock the first is holding.
  const pool = createPool({ databaseUrl, max: 1 });
  const db = createDb(pool);
  try {
    await migrate(db, { migrationsFolder });
  } finally {
    await pool.end();
  }
}

/** `dist/db/migrate.js` → `packages/persistence/drizzle`. */
export function defaultMigrationsFolder(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../drizzle');
}

async function main(): Promise<void> {
  const databaseUrl = process.env['DATABASE_URL'];
  if (databaseUrl === undefined || databaseUrl === '') {
    throw new Error('DATABASE_URL is not defined');
  }
  const folder = defaultMigrationsFolder();
  console.log(`Running migrations from ${folder}`);
  await runMigrations(databaseUrl, folder);
  console.log('Migrations complete');
}

// Only when executed directly, so importing this module for `runMigrations`
// does not start migrating.
if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    console.error('Migration failed', error instanceof Error ? error.stack : String(error));
    process.exit(1);
  });
}
