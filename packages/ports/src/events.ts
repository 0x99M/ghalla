import type { Instant } from '@ghalla/contracts';
import type { EntityRef } from './primitives.js';

/**
 * Deliberately short: only what ingestion actually routes. Members are additive,
 * and the closed union plus `'unknown'` gives the router compile-time
 * exhaustiveness without ever throwing on an unrecognized platform event.
 */
export const PLATFORM_EVENT_TYPES = [
  'order.created',
  'order.updated',
  'order.status_changed',
  'order.cancelled',
  'shipment.created',
  'shipment.updated',
  'shipment.returned',
  'reversal.created',
  'product.updated',
  'store.authorized',
  'store.uninstalled',
  'unknown',
] as const;
export type PlatformEventType = (typeof PLATFORM_EVENT_TYPES)[number];

/**
 * A reference, never a payload. There is no `data`, no `raw`, no `hints`.
 *
 * This carries its weight three times over. It makes a platform's decision to
 * slim down its webhook payloads a non-event, because ingestion refetches
 * regardless of what was inline. It structurally closes the likeliest PII
 * channel, since a webhook body is exactly where a customer's name and phone
 * number arrive. And it fixes out-of-order delivery: refetching yields current
 * state, whereas trusting the payload lets a delayed `created` event overwrite a
 * newer `updated` one.
 */
export interface PlatformEvent {
  readonly type: PlatformEventType;
  /** The platform's verbatim event name. Logged for triage; never branched on outside an adapter. */
  readonly rawType: string;
  /**
   * The idempotency key, stable across redeliveries of the same platform event.
   * Where a platform supplies no event id, the adapter derives one — and it must
   * be a derivation, not a payload hash, because a retried delivery of the same
   * event may differ byte for byte.
   */
  readonly dedupeKey: string;
  /** REQUIRED, never optional: credential lookup needs a tenant before anything else can happen. */
  readonly platformStoreId: string;
  /** `null` for store-lifecycle events, which refer to no entity. */
  readonly subject: EntityRef | null;
  readonly occurredAt: Instant;
  readonly receivedAt: Instant;
}
