import { Injectable } from '@nestjs/common';
import type { Instant, StoreId } from '@ghalla/contracts';
import { applyChange, isPlanCode, seedSubscription } from '@ghalla/billing';
import type { Subscription, SubscriptionChange } from '@ghalla/billing';
import type { BillingEvent, SubscriptionFacts } from '@ghalla/ports';
import { SubscriptionRepository } from '@ghalla/persistence';
import { BillingMetrics } from './billing.metrics.js';

export type HandleResult =
  | { readonly kind: 'applied'; readonly subscription: Subscription }
  | { readonly kind: 'dropped_stale'; readonly reason: string }
  | { readonly kind: 'ignored'; readonly reason: string };

/**
 * Turns a parsed billing webhook into a row change.
 *
 * Runs ON THE QUEUE, never inline in the HTTP handler. The edge does what
 * Phase 1's ingestion edge does: verify the signature, persist the raw delivery
 * to `webhook_events`, return 200 immediately. A platform that does not get its
 * 200 quickly retries, and a handler doing database work inline turns one slow
 * query into a redelivery storm.
 */
@Injectable()
export class BillingEventHandler {
  constructor(
    private readonly subscriptions: SubscriptionRepository,
    private readonly metrics: BillingMetrics,
  ) {}

  /**
   * A billing event says what the subscription now is; this maps its facts onto
   * the change the domain applies.
   *
   * The plan code is validated HERE rather than trusted. An adapter that
   * cannot map a platform plan id sends `null`, and `null` means "did not say",
   * which preserves whatever the row already had. A code that is not a plan we
   * know is treated the same way — better to keep the last good plan than to
   * write a code no build can resolve.
   */
  private toChange(facts: SubscriptionFacts, occurredAt: Instant): SubscriptionChange {
    const planCode = facts.planCode !== null && isPlanCode(facts.planCode) ? facts.planCode : null;
    if (facts.planCode !== null && planCode === null) {
      this.metrics.planUnknown(facts.planCode);
    }
    return {
      status: facts.status,
      planCode,
      platformPlanId: facts.platformPlanId,
      trialEndsAt: facts.trialEndsAt,
      currentPeriodStart: facts.currentPeriodStart,
      currentPeriodEnd: facts.currentPeriodEnd,
      occurredAt,
    };
  }

  async handle(storeId: StoreId, event: BillingEvent): Promise<HandleResult> {
    this.metrics.eventReceived(event.type);

    // An event type we do not model changes nothing. Recorded, not applied:
    // a platform adds event types without telling us, and guessing at one we
    // have never seen is how a subscription gets a status nobody intended.
    if (event.type === 'unknown') {
      return { kind: 'ignored', reason: `unmodelled event type ${event.rawType}` };
    }

    const change = this.toChange(event.facts, event.occurredAt);
    const current = await this.subscriptions.find(storeId);

    if (current === null) {
      const seeded = seedSubscription(storeId, change);
      await this.subscriptions.save(seeded, event.receivedAt);
      this.metrics.eventProcessed(event.type);
      return { kind: 'applied', subscription: seeded };
    }

    const outcome = applyChange(current, change);
    if (outcome.kind === 'stale') {
      // THE guard. Without it a delayed cancellation lands after a renewal and
      // locks out a merchant who has just paid — and nothing in the system
      // notices until they write in.
      this.metrics.eventDroppedAsStale(event.type, storeId, outcome.reason);
      return { kind: 'dropped_stale', reason: outcome.reason };
    }
    // Counted before the write, because the interesting transition is the one
    // that just happened rather than the state that resulted.
    if (current.status === 'trialing' && outcome.next.status === 'active') {
      this.metrics.trialConverted(outcome.next.planCode);
    }
    if (event.type === 'trial_ended') this.metrics.trialExpired();

    await this.subscriptions.save(outcome.next, event.receivedAt);
    this.metrics.eventProcessed(event.type);
    return { kind: 'applied', subscription: outcome.next };
  }
}
