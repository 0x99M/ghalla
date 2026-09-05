import { toMinor } from '@ghalla/contracts';
import type { CanonicalOrder, CanonicalShipment, Minor, ShipmentDirection } from '@ghalla/contracts';
import type { Diagnostic } from '../diagnostics.js';
import type { ShippingFallbackRule } from '../fee-rules.js';
import type { TermBasis } from '../confidence.js';
import { addMinor } from '../money.js';
import { diagnostic, onOrder } from './diagnostics-builder.js';
import type { Computed } from './diagnostics-builder.js';

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

export interface ShippingLeg {
  readonly costMinor: Minor;
  readonly basis: TermBasis;
}

/**
 * Specificity match: a rule matches only where its non-null fields agree, and
 * the most specific match wins.
 *
 * A row with every field null is a legitimate configuration, not a degenerate
 * one — it is the single blended per-shipment number a merchant types at
 * onboarding, which is the recommended way to get a store to first value
 * without a rate-card form standing in the way.
 */
export function matchShippingRule(
  rules: readonly ShippingFallbackRule[],
  order: CanonicalOrder,
  carrier: string | null,
  direction: ShipmentDirection,
): ShippingFallbackRule | null {
  let best: ShippingFallbackRule | null = null;
  let bestScore = -1;
  for (const rule of rules) {
    if (rule.countryCode !== null && rule.countryCode !== order.destination?.countryCode) continue;
    if (rule.region !== null && rule.region !== order.destination?.region) continue;
    if (rule.carrier !== null && rule.carrier !== carrier) continue;
    if (rule.direction !== 'any' && rule.direction !== direction) continue;
    const score =
      (rule.countryCode !== null ? 8 : 0) +
      (rule.region !== null ? 4 : 0) +
      (rule.carrier !== null ? 2 : 0) +
      (rule.direction !== 'any' ? 1 : 0);
    if (score > bestScore) {
      best = rule;
      bestScore = score;
    }
  }
  return best;
}

/**
 * What the courier charged, or what our rules say it would have.
 *
 * Expect the fallback to be the primary path: neither platform in scope exposes
 * actual courier cost to a general merchant application, so a rate card is not
 * a degraded mode here, it is the mechanism.
 *
 * An order with no shipment record yet still gets an estimate rather than a
 * zero. Shipment facts land days after the order, and treating an unshipped
 * order as costless would report every fresh order as unusually profitable.
 */
export function computeShippingCost(
  order: CanonicalOrder,
  shipments: readonly CanonicalShipment[],
  rules: readonly ShippingFallbackRule[],
  direction: ShipmentDirection,
): Computed<ShippingLeg> {
  const diagnostics: Diagnostic[] = [];

  if (order.fulfillmentMethod !== 'carrier') {
    return { value: { costMinor: ZERO, basis: 'not_applicable' }, diagnostics };
  }

  const legs = shipments.filter((s) => s.direction === direction && LIVE.has(s.status));

  if (legs.length === 0) {
    if (direction === 'return') {
      return { value: { costMinor: ZERO, basis: 'not_applicable' }, diagnostics };
    }
    diagnostics.push(onOrder('NO_OUTBOUND_SHIPMENT'));
    const rule = matchShippingRule(rules, order, null, direction);
    if (rule === null) {
      diagnostics.push(onOrder('SHIPPING_FALLBACK_MISSING'));
      return { value: { costMinor: ZERO, basis: 'missing' }, diagnostics };
    }
    diagnostics.push(onOrder('SHIPPING_FALLBACK_USED'));
    return { value: { costMinor: rule.costMinor, basis: 'estimated' }, diagnostics };
  }

  const costs: Minor[] = [];
  let anyEstimated = false;
  let anyMissing = false;

  for (const shipment of legs) {
    if (shipment.carrierCostMinor !== null) {
      costs.push(shipment.carrierCostMinor);
      continue;
    }
    diagnostics.push(diagnostic('CARRIER_COST_MISSING', { kind: 'shipment', shipmentId: shipment.id }));
    const rule = matchShippingRule(rules, order, shipment.carrier, direction);
    if (rule === null) {
      anyMissing = true;
      diagnostics.push(diagnostic('SHIPPING_FALLBACK_MISSING', { kind: 'shipment', shipmentId: shipment.id }));
      continue;
    }
    anyEstimated = true;
    diagnostics.push(diagnostic('SHIPPING_FALLBACK_USED', { kind: 'shipment', shipmentId: shipment.id }));
    costs.push(rule.costMinor);
  }

  const basis: TermBasis = anyMissing ? 'missing' : anyEstimated ? 'estimated' : 'actual';
  return { value: { costMinor: addMinor(...costs), basis }, diagnostics };
}
