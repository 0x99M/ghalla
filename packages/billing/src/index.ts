/**
 * @ghalla/billing — subscription state, entitlements and usage metering.
 *
 * Three concerns, kept apart on purpose, because merging them is the reliable
 * way this becomes unmaintainable:
 *
 *   subscription.ts  what plan is this store on, right now
 *   entitlements.ts  what does that plan permit
 *   usage.ts         how much of the allowance has been consumed
 *
 * Pure, like `core`: no I/O, no clock, no platform vocabulary. Every function
 * that needs the time takes it as an argument, because every interesting case
 * in billing is a boundary and a function reading the wall clock cannot be
 * tested at one.
 */

export type { BillingInterval, Feature, Plan, PlanCode } from './plans.js';
export {
  FEATURES,
  MONTHS_FREE_ON_ANNUAL,
  PLAN_CODES,
  PLANS,
  TRIAL_DAYS,
  TRIAL_PLAN,
  PURCHASABLE_PLAN_CODES,
  annualPriceOf,
  cheapestPlanWith,
  isDowngrade,
  isPlanCode,
  monthlyCapOf,
  planOf,
  priceOf,
} from './plans.js';

export type {
  ApplyOutcome,
  PlanState,
  ReconcileOutcome,
  Subscription,
  SubscriptionChange,
} from './subscription.js';
export {
  applyChange,
  differsFrom,
  effectivePlanCode,
  isStale,
  reconcile,
  seedSubscription,
} from './subscription.js';

export type { AccessDecision, AccessNotice, DashboardAccess, PipelineAccess } from './access.js';
export { decideAccess, isBilled, isPaying, isTrialExpired } from './access.js';

export type { Entitlements } from './entitlements.js';
export { hasFeature, resolveEntitlements } from './entitlements.js';

export { annualisedPrice, toMonthlyRate } from './pricing.js';

export type { CatalogMismatch, CatalogVerdict, PlanListing } from './plan-catalog.js';
export { comparePlanCatalog, describeMismatch } from './plan-catalog.js';

export type { BillingPeriod, CacheEntry, UsageStatus, UsageWindow } from './usage.js';
export { UsageCache, usageCacheKey, usageStatus, usageWindow } from './usage.js';
