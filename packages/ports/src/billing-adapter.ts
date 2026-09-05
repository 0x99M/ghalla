import type { Instant, PlatformId, SubscriptionStatus } from '@ghalla/contracts';
import type { PlatformCredentials } from './credentials.js';
import type { WebhookDelivery, WebhookSecret, WebhookVerification } from './webhook.js';

/**
 * What a billing webhook turned out to be.
 *
 * Normalized, because the point of a port is that `@ghalla/billing` never
 * learns that one platform says `app.subscription.renewed` and another says
 * `plan.charge.succeeded`. `unknown` is a first-class member: a platform will
 * add event types without telling us, and an adapter that throws on one it does
 * not recognise turns a new feature announcement into an outage.
 */
export const BILLING_EVENT_TYPES = [
  'trial_started',
  'trial_ended',
  'subscription_started',
  'subscription_renewed',
  /** A plan change within a period — the upgrade path Phase 2 monetization depends on. */
  'subscription_updated',
  /** Payment failed; the merchant is still a paying customer while retries run. */
  'subscription_past_due',
  'subscription_cancelled',
  'subscription_expired',
  'app_uninstalled',
  'unknown',
] as const;
export type BillingEventType = (typeof BILLING_EVENT_TYPES)[number];

/**
 * The subscription facts an event or a poll carries.
 *
 * Every field beyond `status` is nullable and a `null` means THE SOURCE DID NOT
 * SAY — never "clear this". A cancellation notice carries no period dates, and
 * reading its silence as an instruction would wipe the period the usage window
 * is measured against, resetting a merchant's order count mid-cycle.
 *
 * `planCode` is the NEUTRAL code and mapping to it is the adapter's job: the
 * platform's own plan id is an integer that means nothing here, and letting it
 * reach the entitlement resolver would put one integration's identifier in the
 * middle of a decision that has to survive the next one. `platformPlanId` rides
 * along beside it so that a mapping gap is diagnosable rather than merely wrong.
 */
export interface SubscriptionFacts {
  readonly status: SubscriptionStatus;
  readonly planCode: string | null;
  readonly platformPlanId: string | null;
  readonly trialEndsAt: Instant | null;
  readonly currentPeriodStart: Instant | null;
  readonly currentPeriodEnd: Instant | null;
}

export interface BillingEvent {
  readonly type: BillingEventType;
  readonly rawType: string;
  /** Stable across redeliveries of one event. Feeds `webhook_events`' unique key. */
  readonly dedupeKey: string;
  readonly platformStoreId: string;
  /**
   * When it happened AT THE PLATFORM, not when it reached us.
   *
   * This is the ordering key for the stale-event guard, and it has to be the
   * platform's clock: ordering by arrival orders events by our own queue's
   * behaviour, which is precisely the thing being defended against.
   */
  readonly occurredAt: Instant;
  readonly receivedAt: Instant;
  readonly facts: SubscriptionFacts;
}

/**
 * The platform's current answer, for the nightly reconciler.
 *
 * Deliberately the same `SubscriptionFacts` a webhook carries, so the reconciler
 * and the webhook handler compare like with like. A separate shape here would
 * mean two mapping paths that can disagree, and the disagreement would show up
 * as a nightly correction that is really a bug in the mapping.
 */
export interface PlatformSubscription {
  readonly facts: SubscriptionFacts;
  /** Development stores must be excluded from anything that reports revenue. */
  readonly isDevelopmentStore: boolean;
  /** The platform's own view of when this was true, for the audit trail. */
  readonly observedAt: Instant;
}

export interface BillingAdapter {
  readonly platform: PlatformId;
  /**
   * A billing webhook with no verification path is an unauthenticated
   * entitlement endpoint: anyone who learns the URL can grant themselves a
   * subscription. That is a security defect rather than a missing convenience,
   * and it costs one method reusing types that already exist.
   */
  verifyBillingWebhook(delivery: WebhookDelivery, secret: WebhookSecret): WebhookVerification;
  parseBillingWebhook(delivery: WebhookDelivery): BillingEvent;
  /**
   * Takes credentials, not a Ghalla store id: an adapter has no way to resolve
   * our internal identifier, and handing our persistence keys to a port that
   * must not know about our persistence is backwards.
   *
   * Called by the reconciler and at install. NEVER on a request path — that
   * would put a third party's latency on every page load and their outage on
   * top of ours.
   */
  getSubscription(credentials: PlatformCredentials): Promise<PlatformSubscription>;
}
