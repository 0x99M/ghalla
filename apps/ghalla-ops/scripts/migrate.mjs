#!/usr/bin/env node
// Migration runner for the PORTAL's own database, and for no other.
//
// Plain JavaScript, deliberately. The Drizzle migrator reads the generated SQL
// files and their journal — it never imports the schema module — so this needs
// no TypeScript build step, no drizzle-kit in the runtime image, and no second
// tsconfig to emit one file. Railway's pre-deploy hook runs it directly.
//
// It is pointed at PORTAL_DATABASE_URL and nothing else. The portal holds a
// connection string for every integration database at the same time, and every
// one of those is a database this service is forbidden to write to.
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createPool } from '@ghalla/persistence/pool';

const databaseUrl = process.env.PORTAL_DATABASE_URL;
if (!databaseUrl) {
  console.error('PORTAL_DATABASE_URL is not defined');
  process.exit(1);
}

// max: 1 — a migration is one serialized conversation, and a second connection
// would only wait on a lock the first is holding.
const pool = createPool({ databaseUrl, max: 1, applicationName: 'ghalla-ops:migrate' });
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../drizzle');

try {
  console.log(`Running portal migrations from ${migrationsFolder}`);
  await migrate(drizzle({ client: pool }), { migrationsFolder });
  console.log('Portal migrations complete');
} catch (error) {
  console.error('Portal migration failed', error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
} finally {
  await pool.end();
}
