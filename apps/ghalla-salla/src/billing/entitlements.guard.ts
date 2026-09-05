import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { cheapestPlanWith, hasFeature } from '@ghalla/billing';
import type { Entitlements, Feature } from '@ghalla/billing';
import type { StoreId } from '@ghalla/contracts';
import { EntitlementDeniedException, SubscriptionInactiveException } from './entitlement-denied.exception.js';
import { EntitlementsService } from './entitlements.service.js';
import { REQUIRES_FEATURE } from './requires-feature.decorator.js';

/**
 * What the guard puts on the request, and what everything downstream reads.
 *
 * `storeId` is populated by authentication, which does not exist yet — this is
 * the contract that says what it must supply. Declared here rather than left to
 * `any` so the first auth middleware written has something to satisfy.
 */
export interface BillingRequest {
  storeId?: StoreId;
  entitlements?: Entitlements;
}

/**
 * Resolves entitlements ONCE per request and enforces the route's requirement.
 *
 * Two things happen here and they are deliberately in one place:
 *
 *   1. The subscription is read (one primary-key lookup, no platform call) and
 *      turned into an `Entitlements` that lands on the request. Everything
 *      downstream reads that object instead of asking again — which is what
 *      stops plan checks from spreading into services.
 *   2. The route's declared feature is checked, and the dashboard-level access
 *      decision is applied.
 *
 * Order matters between those two checks. A `canceled` store is refused before
 * the feature is considered, because "your subscription ended" and "that needs
 * a bigger plan" are different messages and showing the second to someone who
 * cancelled is nonsense.
 *
 * Note what is NOT here: any call to the platform. Entitlement on a request
 * path is answered from our own table, always. See docs/0008.
 */
@Injectable()
export class EntitlementsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly entitlements: EntitlementsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<BillingRequest>();
    const storeId = request.storeId;
    // No store on the request means the route is not store-scoped — health,
    // for one. Nothing to entitle, and inventing a denial here would break
    // every unauthenticated endpoint.
    if (storeId === undefined) return true;

    const resolved = await this.entitlements.forStore(storeId);
    request.entitlements = resolved;

    // Locked beats every other consideration, and the export route is expected
    // to opt out of this guard entirely rather than be special-cased here.
    if (resolved.access.dashboard === 'locked') {
      throw new SubscriptionInactiveException(resolved.access.notice);
    }

    const required = this.reflector.getAllAndOverride<Feature | undefined>(REQUIRES_FEATURE, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (required === undefined) return true;

    if (!hasFeature(resolved, required)) {
      throw new EntitlementDeniedException(required, resolved.planCode, cheapestPlanWith(required));
    }
    return true;
  }
}
