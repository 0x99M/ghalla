import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { Database } from '@ghalla/persistence';
import { DRIZZLE } from '../db/db.module.js';

export interface HealthReport {
  readonly status: 'ok' | 'degraded';
  readonly database: 'ok' | 'unreachable';
  readonly environment: string | undefined;
  readonly commit: string | undefined;
}

@Injectable()
export class HealthService {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /**
   * Actually touches the database.
   *
   * A healthcheck that only proves the process is listening is worse than none
   * on Railway: the deploy goes green, traffic switches over, and the first
   * request discovers that the database URL is wrong. One round trip is cheap
   * enough to run on every check and is the only thing that distinguishes
   * "running" from "working".
   */
  async check(env: { railwayEnvironment?: string | undefined; gitSha?: string | undefined }): Promise<HealthReport> {
    let database: HealthReport['database'] = 'ok';
    try {
      await this.db.execute(sql`SELECT 1`);
    } catch {
      database = 'unreachable';
    }
    return {
      status: database === 'ok' ? 'ok' : 'degraded',
      database,
      environment: env.railwayEnvironment,
      commit: env.gitSha,
    };
  }
}
