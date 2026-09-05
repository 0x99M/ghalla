import { Controller, Get, HttpCode, HttpStatus, Res } from '@nestjs/common';
import type { Response } from 'express';
import { loadEnv } from '../config/env.js';
import type { Env } from '../config/env.js';
import { HealthService } from './health.service.js';
import type { HealthReport } from './health.service.js';

@Controller('api/v1')
export class HealthController {
  /**
   * Read ONCE, when the controller is constructed.
   *
   * Re-reading per request meant a healthcheck could throw `ConfigError` and
   * hand the platform a 500 with a stack trace, instead of the structured
   * `{ status: 'degraded' }` this endpoint exists to produce — the exact failure
   * its own comment argues against. `main.ts` already validates the environment
   * at boot, which is where a missing DATABASE_URL is supposed to stop things.
   */
  private readonly env: Env = loadEnv();

  constructor(private readonly health: HealthService) {}

  /**
   * Railway polls this. It must return 503 when the database is unreachable,
   * not 200 with a sad-looking body — the platform reads the STATUS CODE, and a
   * 200 tells it to route production traffic at a service that cannot answer.
   */
  @Get('health')
  @HttpCode(HttpStatus.OK)
  async healthcheck(@Res({ passthrough: true }) response: Response): Promise<HealthReport> {
    const report = await this.health.check(this.env);
    if (report.status !== 'ok') response.status(HttpStatus.SERVICE_UNAVAILABLE);
    return report;
  }

  /** Liveness only: is the process up. Deliberately touches nothing. */
  @Get('ping')
  ping(): { readonly pong: true } {
    return { pong: true };
  }
}
