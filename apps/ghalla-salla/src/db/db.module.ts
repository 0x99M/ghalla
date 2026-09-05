import { Global, Inject, Logger, Module, OnApplicationShutdown } from '@nestjs/common';
import { Pool } from 'pg';
import { createDb, createPool } from '@ghalla/persistence';
import type { Database } from '@ghalla/persistence';
import { loadEnv } from '../config/env.js';

export const DRIZZLE = Symbol('DRIZZLE');
export const PG_POOL = Symbol('PG_POOL');

export type { Database };

/**
 * Global so a repository can inject DRIZZLE without every feature module
 * importing this one. One pool per process, closed on shutdown so a rolling
 * deploy does not leave connections behind — Postgres has a hard cap on them,
 * and a leaked pool per deploy reaches it after a surprisingly small number of
 * releases.
 */
@Global()
@Module({
  providers: [
    {
      provide: PG_POOL,
      useFactory: (): Pool => {
        const env = loadEnv();
        return createPool({
          databaseUrl: env.databaseUrl,
          sslMode: env.databaseSslMode,
          max: env.databasePoolMax,
        });
      },
    },
    {
      provide: DRIZZLE,
      inject: [PG_POOL],
      useFactory: (pool: Pool): Database => createDb(pool),
    },
  ],
  exports: [DRIZZLE, PG_POOL],
})
export class DbModule implements OnApplicationShutdown {
  private readonly logger = new Logger(DbModule.name);

  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
    this.logger.log('Postgres pool closed');
  }
}
