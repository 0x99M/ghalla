import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';

/**
 * The PORTAL's own database, which is not any integration's database.
 *
 * Deliberately a different variable name from `DATABASE_URL`: the portal holds
 * connection strings for every integration at once, and a generated migration
 * pointed at one of those would be a write to a database this service is not
 * allowed to write to at all.
 */
if (!process.env['PORTAL_DATABASE_URL']) {
  throw new Error('PORTAL_DATABASE_URL is not defined');
}

export default defineConfig({
  out: './drizzle',
  schema: './src/lib/db/portal-schema.ts',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env['PORTAL_DATABASE_URL'],
  },
});
