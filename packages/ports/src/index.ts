/**
 * @ghalla/ports — the interfaces a platform integration must satisfy.
 *
 * Depends on @ghalla/contracts and nothing else. This is the only package
 * outside apps/* that may see `Ingested<T>`, because it is the ingestion
 * boundary: the raw platform payload stops here.
 */

export type { Cursor, DateRange, EntityRef, Page } from './primitives.js';
export { toCursor } from './primitives.js';

export type { Secret, SecretBag } from './secret.js';
export { isSecret, secret } from './secret.js';

export type { PlatformCredentials } from './credentials.js';

export type { AuthGrant, WebhookDelivery, WebhookSecret, WebhookVerification } from './webhook.js';
export { normalizeHeaders } from './webhook.js';

export type { PlatformEvent, PlatformEventType } from './events.js';
export { PLATFORM_EVENT_TYPES } from './events.js';

export type { BundlePart, OrderBundle } from './bundle.js';
export { BUNDLE_PARTS } from './bundle.js';

export type { AdapterError, AdapterErrorKind } from './errors.js';
export { ADAPTER_ERROR_KINDS, isAdapterError } from './errors.js';

export type { PlatformAdapter } from './platform-adapter.js';

export type {
  BillingAdapter,
  BillingEvent,
  BillingEventType,
  PlatformSubscription,
  SubscriptionFacts,
} from './billing-adapter.js';
export { BILLING_EVENT_TYPES } from './billing-adapter.js';
