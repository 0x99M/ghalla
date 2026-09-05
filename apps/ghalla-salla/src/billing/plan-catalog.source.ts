import type { PlatformPlan } from '@ghalla/ports';

/**
 * How we ask the platform what plans it has configured for this app.
 *
 * Narrower than `BillingAdapter` for the same reason `SubscriptionSource` is:
 * this needs one question answered and has no business holding a whole adapter.
 *
 * UNBOUND until the adapter lands, and the consequence is stated rather than
 * hidden: the check reports `unverified`, not `ok`. A component that silently
 * does nothing is indistinguishable from one that found nothing wrong, and
 * those are opposite situations — here especially, because "nothing wrong"
 * would be a green light on the one thing standing between a price edited in a
 * partner portal and a merchant charged for a tier this code will not grant.
 */
export interface PlanCatalogSource {
  fetchPlans(): Promise<readonly PlatformPlan[]>;
}

/** Its own module so the token can be imported without dragging in a provider. */
export const PLAN_CATALOG_SOURCE = Symbol('PLAN_CATALOG_SOURCE');
