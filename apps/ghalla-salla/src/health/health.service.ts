import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { readMigrationState } from '@ghalla/persistence';
import type { Database, MigrationState } from '@ghalla/persistence';
import { DRIZZLE } from '../db/db.module.js';
import { MIGRATIONS_FOLDER } from './migrations-folder.js';

export interface HealthReport {
  readonly status: 'ok' | 'degraded';
  readonly database: 'ok' | 'unreachable';
  readonly schema: MigrationState['status'];
  readonly migrations: { readonly applied: number; readonly expected: number };
  readonly environment: string | undefined;
  readonly commit: string | undefined;
}

@Injectable()
export class HealthService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    @Inject(MIGRATIONS_FOLDER) private readonly migrationsFolder: string,
  ) {}

  /**
   * Actually touches the database, and checks it is the right SHAPE.
   *
   * A healthcheck that only proves the process is listening is worse than none
   * on Railway: the deploy goes green, traffic switches over, and the first
   * request discovers that the database URL is wrong. One round trip is cheap
   * enough to run on every check and is the only thing that distinguishes
   * "running" from "working".
   *
   * The schema check is the second half of that argument. Migrations run in the
   * pre-deploy hook, so `behind` should be impossible — which is exactly why it
   * is worth asserting. The failure it catches (a hook silently unset, a
   * rollback to an image older than the schema, a database swapped underneath)
   * produces a process that starts, answers, and returns wrong numbers. Failing
   * the healthcheck turns that into a deploy that does not complete, which is
   * the outcome we want: a merchant seeing no dashboard beats a merchant seeing
   * a confident wrong one.
   */
  async check(env: {
    railwayEnvironment?: string | undefined;
    gitSha?: string | undefined;
  }): Promise<HealthReport> {
    let database: HealthReport['database'] = 'ok';
    try {
      await this.db.execute(sql`SELECT 1`);
    } catch {
      database = 'unreachable';
    }

    // Skipped when the database is unreachable: it would report `unknown` and
    // add a second failing round trip to say what the first already said.
    const migrations: MigrationState =
      database === 'ok'
        ? await readMigrationState(this.db, this.migrationsFolder)
        : { expected: 0, applied: 0, latest: null, status: 'unknown' };

    return {
      status: database === 'ok' && migrations.status === 'current' ? 'ok' : 'degraded',
      database,
      schema: migrations.status,
      migrations: { applied: migrations.applied, expected: migrations.expected },
      environment: env.railwayEnvironment,
      commit: env.gitSha,
    };
  }
}
