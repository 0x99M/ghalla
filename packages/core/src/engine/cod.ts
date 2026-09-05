import { toMinor } from '@ghalla/contracts';
import type { CanonicalOrder, CanonicalShipment, Minor } from '@ghalla/contracts';
import type { Diagnostic } from '../diagnostics.js';
import type { CodFeeRule } from '../fee-rules.js';
import type { TermBasis } from '../confidence.js';
import { addMinor } from '../money.js';
import { NO_FEE, applyFeeFormula, basisOfFeeSource } from './fee.js';
import { diagnostic } from './diagnostics-builder.js';
import type { Computed } from './diagnostics-builder.js';

const ZERO = toMinor(0);

export interface CodCost {
  readonly exVatMinor: Minor;
  readonly vatMinor: Minor;
  readonly costMinor: Minor;
  readonly basis: TermBasis;
}

/**
 * The courier's cash-handling charge.
 *
 * Keyed by CARRIER, and percent-plus-fixed rather than a flat store constant.
 * Couriers publish it that way and the rate differs between two couriers a
 * single store uses on the same day, so a constant diverges without bound
 * across the basket-size distribution — in the direction that flatters margin.
 *
 * Charged only against a CAPTURED cash-on-delivery leg. A parcel that came back
 * uncollected was never handed cash to handle, so it accrues no fee here — its
 * loss is the two shipping legs, which is where it belongs.
 */
export function computeCodCost(
  order: CanonicalOrder,
  shipments: readonly CanonicalShipment[],
  rules: readonly CodFeeRule[],
  vatRegistered: boolean,
): Computed<CodCost> {
  const diagnostics: Diagnostic[] = [];
  const legs = order.payments
    .map((payment, index) => ({ payment, index }))
    .filter(({ payment }) => payment.instrument === 'cod' && payment.state === 'captured');

  if (legs.length === 0) {
    return { value: { exVatMinor: ZERO, vatMinor: ZERO, costMinor: ZERO, basis: 'not_applicable' }, diagnostics };
  }

  const carrier = shipments.find((s) => s.direction === 'outbound')?.carrier ?? null;

  const applied = legs.map(({ payment, index }) => {
    let best: CodFeeRule | null = null;
    let bestScore = -1;
    for (const rule of rules) {
      if (rule.carrier !== null && rule.carrier !== carrier) continue;
      const score = rule.carrier !== null ? 1 : 0;
      if (score > bestScore) {
        best = rule;
        bestScore = score;
      }
    }
    if (best === null) {
      diagnostics.push(diagnostic('COD_FEE_RULE_MISSING', { kind: 'payment', index }));
      return { fee: NO_FEE, basis: 'missing' as TermBasis };
    }
    if (best.source === 'default_table') {
      diagnostics.push(diagnostic('FEE_RULE_DEFAULT_USED', { kind: 'payment', index }));
    }
    return {
      fee: applyFeeFormula(payment.amountGrossMinor, best, vatRegistered),
      basis: basisOfFeeSource(best.source),
    };
  });

  const basis: TermBasis = applied.some((a) => a.basis === 'missing')
    ? 'missing'
    : applied.some((a) => a.basis === 'estimated')
      ? 'estimated'
      : 'actual';

  return {
    value: {
      exVatMinor: addMinor(...applied.map((a) => a.fee.exVatMinor)),
      vatMinor: addMinor(...applied.map((a) => a.fee.vatMinor)),
      costMinor: addMinor(...applied.map((a) => a.fee.costMinor)),
      basis,
    },
    diagnostics,
  };
}
