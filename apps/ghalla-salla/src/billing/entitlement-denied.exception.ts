import { HttpException, HttpStatus } from '@nestjs/common';
import type { Feature, PlanCode } from '@ghalla/billing';

export interface EntitlementDeniedBody {
  readonly error: 'entitlement_required';
  /** What the route needed. */
  readonly feature: Feature;
  /** What they are on now. */
  readonly currentPlan: string;
  /** The cheapest plan that includes it — `null` only if no plan does. */
  readonly requiredPlan: PlanCode | null;
  readonly message: string;
}

/**
 * A denial the frontend can act on.
 *
 * A bare 403 makes the merchant guess what to buy, and guessing wrong is a
 * support ticket or a lost sale. Naming the feature and the cheapest plan that
 * carries it turns a dead end into a checkout link, which is the entire reason
 * to gate a feature rather than hide it: a hidden feature sells nothing.
 *
 * 402 rather than 403. The distinction is real and the frontend routes on it —
 * 403 means "not for you", which prompts a support ticket, and 402 means "not
 * yet", which prompts an upgrade screen.
 */
export class EntitlementDeniedException extends HttpException {
  constructor(feature: Feature, currentPlan: string, requiredPlan: PlanCode | null) {
    const body: EntitlementDeniedBody = {
      error: 'entitlement_required',
      feature,
      currentPlan,
      requiredPlan,
      message:
        requiredPlan === null
          ? `${feature} is not available on any current plan.`
          : `${feature} requires the ${requiredPlan} plan; this store is on ${currentPlan}.`,
    };
    super(body, HttpStatus.PAYMENT_REQUIRED);
  }
}

/**
 * The dashboard is locked entirely — a canceled subscription.
 *
 * Separate from the feature denial because the remedy is different: this one is
 * "resubscribe", not "upgrade", and the export link stays live underneath it.
 */
export class SubscriptionInactiveException extends HttpException {
  constructor(status: string) {
    super(
      {
        error: 'subscription_inactive',
        status,
        message: `This store's subscription is ${status}. Data export remains available.`,
      },
      HttpStatus.PAYMENT_REQUIRED,
    );
  }
}
