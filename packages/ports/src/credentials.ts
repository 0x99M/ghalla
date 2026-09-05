import type { Instant } from '@ghalla/contracts';
import type { SecretBag } from './secret.js';

export interface PlatformCredentials {
  readonly platformStoreId: string;
  /**
   * Absolute instants only, never a duration.
   *
   * At least one platform returns its expiry as a *duration* from the token
   * endpoint and as an *epoch timestamp* from the install webhook, under the
   * same field name. A duration-shaped field would let that ambiguity survive
   * into the database and fail silently in both directions; making the type
   * absolute forces the adapter to resolve it at the one place the platform's
   * own convention is known.
   */
  readonly expiresAt: Instant | null;
  /**
   * Refresh tokens expire too, and on at least one platform they are single-use
   * and rotating — so a store that goes quiet for a month needs the merchant to
   * reconnect. The scheduler is platform-agnostic and cannot know that without
   * this field.
   */
  readonly refreshExpiresAt: Instant | null;
  /**
   * OPAQUE, adapter-owned key set, persisted as a single encrypted blob.
   *
   * Not a named record of `accessToken`/`refreshToken`: one platform issues
   * three secrets and sends the same value under two different header names
   * depending on which component is being called. A named record cannot hold
   * that, and a generic type parameter would be viral across every port
   * signature for no gain, since persistence only ever encrypts the blob.
   */
  readonly secrets: SecretBag;
}
