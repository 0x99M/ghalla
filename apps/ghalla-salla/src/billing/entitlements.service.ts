import { Injectable } from '@nestjs/common';
import { toInstant } from '@ghalla/contracts';
import type { Instant, StoreId } from '@ghalla/contracts';
import {
  TRIAL_PLAN,
  UsageCache,
  resolveEntitlements,
  usageCacheKey,
  usageStatus,
  usageWindow,
} from '@ghalla/billing';
import type { Entitlements, Subscription, UsageStatus } from '@ghalla/billing';
import { SubscriptionRepository } from '@ghalla/persistence';
import { BillingMetrics } from './billing.metrics.js';

/**
 * A store with no subscription row.
 *
 * Happens between an install completing and its first billing webhook landing —
 * a window of seconds, but a window that a merchant clicking through the
 * onboarding will hit. Treated as a trial that has already started: the
 * alternative, denying everything until a webhook arrives, means the first
 * thing a new merchant sees is a payment wall.
 *
 * The period is a placeholder that the first real event overwrites. It exists
 * so `usageWindow` has something to measure against rather than crashing.
 */
function provisionalTrial(storeId: StoreId, now: Instant): Subscription {
  const start = new Date(now);
  const end = new Date(start.getTime() + 14 * 86_400_000);
  return {
    storeId,
    planCode: TRIAL_PLAN,
    platformPlanId: null,
    status: 'trialing',
    trialEndsAt: toInstant(end.toISOString()),
    currentPeriodStart: now,
    currentPeriodEnd: toInstant(end.toISOString()),
    lastEventAt: null,
    lastReconciledAt: null,
  };
}

export interface StoreBilling {
  readonly subscription: Subscription;
  readonly entitlements: Entitlements;
  readonly usage: UsageStatus;
}

@Injectable()
export class EntitlementsService {
  constructor(
    private readonly subscriptions: SubscriptionRepository,
    private readonly cache: UsageCache,
    private readonly metrics: BillingMetrics,
  ) {}

  /** Injected as a function so a test can pin the clock at a period boundary. */
  protected nowInstant(): Instant {
    return toInstant(new Date().toISOString());
  }

  /**
   * The full billing picture for a store.
   *
   * One primary-key read plus, at most, one cached aggregate. No platform call,
   * on any path that reaches here.
   */
  async describe(storeId: StoreId): Promise<StoreBilling> {
    const now = this.nowInstant();
    const subscription = (await this.subscriptions.find(storeId)) ?? provisionalTrial(storeId, now);

    const window = usageWindow(subscription);
    const key = usageCacheKey(storeId, window);
    const millis = new Date(now).getTime();

    let count = this.cache.get(key, millis);
    if (count === null) {
      count = await this.subscriptions.countLiveOrders(storeId, window);
      this.cache.set(key, count, millis);
    }

    // Resolved BEFORE the cap is known, then again with it — no: resolved once,
    // with the over-cap flag computed from the plan's own cap. The plan is read
    // twice here only because the cap belongs to it, and doing it in this order
    // keeps `resolveEntitlements` the single place access is decided.
    const provisional = resolveEntitlements(subscription, now, false);
    const usage = usageStatus(count, provisional.orderCap);
    const entitlements = resolveEntitlements(subscription, now, usage.overCap);

    if (entitlements.planUnknown) this.metrics.planUnknown(subscription.planCode);
    if (usage.overCap) this.metrics.overCap(entitlements.planCode);

    return { subscription, entitlements, usage };
  }

  async forStore(storeId: StoreId): Promise<Entitlements> {
    return (await this.describe(storeId)).entitlements;
  }
}
