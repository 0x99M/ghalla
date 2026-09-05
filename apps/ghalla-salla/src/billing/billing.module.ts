import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { UsageCache } from '@ghalla/billing';
import { SubscriptionRepository } from '@ghalla/persistence';
import type { Database } from '@ghalla/persistence';
import { DRIZZLE, DbModule } from '../db/db.module.js';
import { BillingEventHandler } from './billing-event.handler.js';
import { BillingMetrics } from './billing.metrics.js';
import { EntitlementsGuard } from './entitlements.guard.js';
import { EntitlementsService } from './entitlements.service.js';
import { ReconciliationService } from './reconciliation.service.js';
import { SubscriptionRefreshService } from './subscription-refresh.service.js';

/**
 * Billing wiring.
 *
 * The guard is provided but NOT registered globally, and no controller carries
 * `@RequiresFeature` yet. That is deliberate: there is nothing store-scoped to
 * gate until the dashboard API exists, and a globally-registered guard would
 * start resolving entitlements for the healthcheck.
 *
 * `SUBSCRIPTION_SOURCE` is likewise unbound. The reconciler logs and skips
 * without it rather than pretending it found no drift — the Salla adapter fills
 * that slot.
 */
@Module({
  imports: [DbModule, ScheduleModule.forRoot()],
  providers: [
    BillingMetrics,
    // One cache per process, five-minute TTL. In-process rather than Redis:
    // this number drives a banner, not enforcement. See docs/0008.
    { provide: UsageCache, useFactory: (): UsageCache => new UsageCache(300_000) },
    {
      provide: SubscriptionRepository,
      useFactory: (db: Database): SubscriptionRepository => new SubscriptionRepository(db),
      inject: [DRIZZLE],
    },
    EntitlementsService,
    EntitlementsGuard,
    BillingEventHandler,
    SubscriptionRefreshService,
    ReconciliationService,
  ],
  exports: [
    EntitlementsService,
    EntitlementsGuard,
    BillingEventHandler,
    SubscriptionRefreshService,
    ReconciliationService,
    BillingMetrics,
  ],
})
export class BillingModule {}
