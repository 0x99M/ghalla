import { SetMetadata } from '@nestjs/common';
import type { Feature } from '@ghalla/billing';

export const REQUIRES_FEATURE = 'ghalla:requires-feature';

/**
 * Declares the feature a route needs.
 *
 *     @RequiresFeature('attribution')
 *     @Get('campaigns')
 *     getCampaigns() { … }
 *
 * The gate is DECLARATIVE and it is the only form allowed. An `if (plan ===
 * 'growth')` inside a service is invisible from the route, drifts from its
 * neighbours, and gets forgotten on the next endpoint — which is how feature
 * gating rots into "whatever the accumulated conditionals happen to compute".
 * Here the requirement sits on the handler, one line above the method, where a
 * reviewer reading the route sees it.
 *
 * A route with no decorator requires nothing beyond a dashboard the merchant is
 * allowed to see at all — which the guard still checks, because `canceled` must
 * not read its own data.
 */
export const RequiresFeature = (feature: Feature): MethodDecorator & ClassDecorator =>
  SetMetadata(REQUIRES_FEATURE, feature);
