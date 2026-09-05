import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { BillingModule } from './billing/billing.module.js';
import { DbModule } from './db/db.module.js';
import { HealthModule } from './health/health.module.js';
import { loadEnv } from './config/env.js';
import { buildLoggerOptions } from './logging/log-config.js';

/**
 * The Salla service.
 *
 * Only health and the database so far. The adapter, the webhook controllers,
 * the cost onboarding and the dashboard API land here as their own modules —
 * this exists now so the deployment topology, the migration pipeline and the
 * healthcheck are proven before there is anything complicated to debug.
 *
 * Logging is wired at the root because it has to cover the request that fails
 * before reaching a controller. `nestjs-pino` supplies the plumbing —
 * per-request child loggers over AsyncLocalStorage, and the correlation id
 * threaded through them — while every decision that could leak a merchant's
 * data lives in `logging/`, where it is a pure function with tests on it.
 */
@Module({
  imports: [
    LoggerModule.forRoot({ pinoHttp: buildLoggerOptions(loadEnv()) }),
    DbModule,
    HealthModule,
    // Loaded for the reconciliation cron. The entitlements guard it provides is
    // deliberately NOT registered globally and no controller carries
    // `@RequiresFeature` yet — there is nothing store-scoped to gate until the
    // dashboard API exists, and a global guard would start resolving
    // entitlements for the healthcheck.
    BillingModule,
  ],
})
export class AppModule {}
