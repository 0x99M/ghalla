import type { Instant, PlatformId } from '@ghalla/contracts';
import type { PlatformCredentials } from './credentials.js';
import type { WebhookDelivery, WebhookSecret, WebhookVerification } from './webhook.js';

export const BILLING_EVENT_TYPES = [
  'trial_started',
  'subscription_started',
  'subscription_renewed',
  'subscription_cancelled',
  'subscription_expired',
  'app_uninstalled',
  'unknown',
] as const;
export type BillingEventType = (typeof BILLING_EVENT_TYPES)[number];

export interface BillingEvent {
  readonly type: BillingEventType;
  readonly rawType: string;
  readonly dedupeKey: string;
  readonly platformStoreId: string;
  readonly occurredAt: Instant;
  readonly receivedAt: Instant;
}

export interface StoreSubscription {
  readonly state: 'trialing' | 'active' | 'lapsed' | 'revoked';
  readonly planSlug: string;
  readonly currentPeriodEnd: Instant | null;
  /** Development stores must be excluded from anything that reports revenue. */
  readonly isDevelopmentStore: boolean;
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
   */
  getSubscription(credentials: PlatformCredentials): Promise<StoreSubscription>;
}
