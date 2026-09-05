import { Module } from '@nestjs/common';
import { DbModule } from './db/db.module.js';
import { HealthModule } from './health/health.module.js';

/**
 * The Salla service.
 *
 * Only health and the database so far. The adapter, the webhook controllers,
 * the cost onboarding and the dashboard API land here as their own modules —
 * this exists now so the deployment topology, the migration pipeline and the
 * healthcheck are proven before there is anything complicated to debug.
 */
@Module({
  imports: [DbModule, HealthModule],
})
export class AppModule {}
