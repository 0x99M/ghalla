import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import * as portalSchema from '../../src/lib/db/portal-schema';
import type { PortalDatabase } from '../../src/lib/db/portal-db';

const MIGRATIONS = path.resolve(import.meta.dirname, '../../drizzle');

export interface PortalTestDb {
  readonly client: PGlite;
  readonly db: PortalDatabase;
  close(): Promise<void>;
}

export async function createPortalDb(): Promise<PortalTestDb> {
  const client = new PGlite();
  const db = drizzle({ client, schema: portalSchema });
  await migrate(db, { migrationsFolder: MIGRATIONS });
  return {
    client,
    db,
    close: async () => {
      await client.close();
    },
  };
}
