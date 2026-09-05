import type { PlatformSubscription } from '@ghalla/ports';

/**
 * How we ask the platform about ONE store.
 *
 * Deliberately narrower than `BillingAdapter`: this needs one question
 * answered and has no business holding a whole adapter — and the credentials
 * lookup, which the adapter port explicitly refuses to do because it cannot
 * resolve our store ids, has somewhere to live on this side of the line.
 *
 * UNIMPLEMENTED until the Salla adapter lands. Everything that depends on it is
 * written and tested against this interface now, so the adapter arrives into a
 * slot rather than a design decision. Nothing binds the token, and the callers
 * report `unavailable` rather than pretending they found no drift — a component
 * that silently does nothing is indistinguishable from one that found nothing
 * wrong, and those are opposite situations.
 */
export interface SubscriptionSource {
  /** `null` means the platform does not recognise this store. */
  fetch(storeId: string): Promise<PlatformSubscription | null>;
}

/** Its own module so the token can be imported without dragging in a provider — that would be a cycle. */
export const SUBSCRIPTION_SOURCE = Symbol('SUBSCRIPTION_SOURCE');
