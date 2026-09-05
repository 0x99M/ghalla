import { toMinor } from '@ghalla/contracts';
import type { CanonicalOrder, CanonicalShipment, Minor, ShipmentDirection } from '@ghalla/contracts';
import type { Diagnostic } from '../diagnostics.js';
import type { ShippingFallbackRule } from '../fee-rules.js';
import type { TermBasis } from '../confidence.js';
import { addMinor } from '../money.js';
import { diagnostic, onOrder } from './diagnostics-builder.js';
import type { Computed } from './diagnostics-builder.js';
import { DISPATCHED } from './recognition.js';

const ZERO = toMinor(0);

/** A shipment that never dispatched costs nothing. */
const LIVE = new Set([
  'created',
  'in_transit',
  'out_for_delivery',
  'delivered',
  'failed_attempt',
  'returned_to_origin',
  'lost',
  'unknown',
]);

export interface ShipmentCost {
  readonly shipmentId: string;
  readonly costMinor: Minor;
  /** Which lines travelled in this parcel, when the platform reported the mapping. */
  readonly lineIds: readonly string[];
}

export interface ShippingLeg {
  readonly costMinor: Minor;
  readonly basis: TermBasis;
  /**
   * Per-parcel costs, so freight can be attributed to the SKUs that actually
   * travelled in each one rather than smeared across the order by revenue.
   */
  readonly parcels: readonly ShipmentCost[];
}

/**
 * Specificity match, with DIRECTION as a filter rather than a score.
 *
 * Direction is not a weak signal that a country row should outrank — a return
 * leg genuinely prices differently, and return shipping is a separately named
 * headline term. Scoring it at one point meant a merchant who added their
 * return rate on top of a blended national rate kept paying the blended rate on
 * every RTO, which is exactly the upgrade path the onboarding design promises.
 *
 * A row with every field null is a legitimate configuration, not a degenerate
 * one: it is the single blended per-shipment number a merchant types at
 * onboarding.
 */
export function matchShippingRule(
  rules: readonly ShippingFallbackRule[],
  order: CanonicalOrder,
  carrier: string | null,
  direction: ShipmentDirection,
): ShippingFallbackRule | null {
  const geographyMatches = (rule: ShippingFallbackRule): boolean => {
    if (rule.countryCode !== null && rule.countryCode !== order.destination?.countryCode) return false;
    if (rule.region !== null && rule.region !== order.destination?.region) return false;
    if (rule.carrier !== null && rule.carrier !== carrier) return false;
    return true;
  };
  const score = (rule: ShippingFallbackRule): number =>
    (rule.countryCode !== null ? 4 : 0) + (rule.region !== null ? 2 : 0) + (rule.carrier !== null ? 1 : 0);

  const pick = (candidates: readonly ShippingFallbackRule[]): ShippingFallbackRule | null => {
    let best: ShippingFallbackRule | null = null;
    let bestScore = -1;
    for (const rule of candidates) {
      if (!geographyMatches(rule)) continue;
      if (score(rule) > bestScore) {
        best = rule;
        bestScore = score(rule);
      }
    }
    return best;
  };

  // A rule written for this direction always beats one written for either.
  return pick(rules.filter((r) => r.direction === direction)) ?? pick(rules.filter((r) => r.direction === 'any'));
}

/**
 * What the courier charged, or what the merchant's rules say it would have.
 *
 * Expect the fallback to be the primary path: neither platform in scope exposes
 * actual courier cost to a general merchant application, so a rate card is not
 * a degraded mode here, it is the mechanism.
 *
 * `fulfillmentMethod` gates the FALLBACK, not the sum. A settled charge on a
 * real shipment is a fact, and discarding it because the order was labelled
 * `self_delivery` deletes reported money — the field exists to stop the engine
 * INVENTING a courier charge for a pickup order, which is a different thing.
 */
export function computeShippingCost(
  order: CanonicalOrder,
  shipments: readonly CanonicalShipment[],
  rules: readonly ShippingFallbackRule[],
  direction: ShipmentDirection,
): Computed<ShippingLeg> {
  const diagnostics: Diagnostic[] = [];
  const legs = shipments.filter((s) => s.direction === direction && LIVE.has(s.status));
  const mayEstimate = order.fulfillmentMethod === 'carrier';

  if (legs.length === 0) {
    if (direction === 'return' || !mayEstimate) {
      return { value: { costMinor: ZERO, basis: 'not_applicable', parcels: [] }, diagnostics };
    }
    // A cancelled order that never dispatched has no parcel to estimate. The
    // fallback's justification — "shipment facts land days after the order" — is
    // about an OPEN order, which this one will never become again.
    if (order.lifecycle === 'cancelled' && !DISPATCHED.has(order.fulfillmentState)) {
      return { value: { costMinor: ZERO, basis: 'not_applicable', parcels: [] }, diagnostics };
    }
    diagnostics.push(onOrder('NO_OUTBOUND_SHIPMENT'));
    const rule = matchShippingRule(rules, order, null, direction);
    if (rule === null) {
      diagnostics.push(onOrder('SHIPPING_FALLBACK_MISSING'));
      return { value: { costMinor: ZERO, basis: 'missing', parcels: [] }, diagnostics };
    }
    diagnostics.push(onOrder('SHIPPING_FALLBACK_USED'));
    return {
      value: { costMinor: rule.costMinor, basis: 'estimated', parcels: [] },
      diagnostics,
    };
  }

  const parcels: ShipmentCost[] = [];
  let anyEstimated = false;
  let anyMissing = false;

  for (const shipment of legs) {
    const lineIds = shipment.lines.map((l) => l.orderItemId);

    if (shipment.carrierCostMinor !== null) {
      parcels.push({ shipmentId: shipment.id, costMinor: shipment.carrierCostMinor, lineIds });
      continue;
    }
    diagnostics.push(diagnostic('CARRIER_COST_MISSING', { kind: 'shipment', shipmentId: shipment.id }));

    if (!mayEstimate) {
      // No settled charge and no licence to invent one.
      anyMissing = true;
      continue;
    }
    const rule = matchShippingRule(rules, order, shipment.carrier, direction);
    if (rule === null) {
      anyMissing = true;
      diagnostics.push(diagnostic('SHIPPING_FALLBACK_MISSING', { kind: 'shipment', shipmentId: shipment.id }));
      continue;
    }
    anyEstimated = true;
    diagnostics.push(diagnostic('SHIPPING_FALLBACK_USED', { kind: 'shipment', shipmentId: shipment.id }));
    parcels.push({ shipmentId: shipment.id, costMinor: rule.costMinor, lineIds });
  }

  const basis: TermBasis = anyMissing
    ? 'missing'
    : anyEstimated
      ? 'estimated'
      : parcels.length === 0
        ? 'not_applicable'
        : 'actual';

  return {
    value: { costMinor: addMinor(...parcels.map((p) => p.costMinor)), basis, parcels },
    diagnostics,
  };
}
