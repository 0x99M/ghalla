import { toMinor } from '@ghalla/contracts';
import type { CanonicalOrder, CanonicalShipment, Minor } from '@ghalla/contracts';
import type { Diagnostic } from '../diagnostics.js';
import type { CodFeeRule } from '../fee-rules.js';
import type { TermBasis } from '../confidence.js';
import { addMinor, allocateMinor } from '../money.js';
import { applyFeeFormula, basisOfFeeSource } from './fee.js';
import { diagnostic } from './diagnostics-builder.js';
import type { Computed } from './diagnostics-builder.js';

const ZERO = toMinor(0);

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
 * single store uses on the same day — which is also why the carrier cannot be
 * "whichever shipment sorted first". A split-fulfilment order taking the wrong
 * one is a 2.5x error decided by a shipment id.
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

  // Only parcels that actually travelled can have carried the cash, and a
  // cancelled label never did.
  const carriers = [
    ...new Set(shipments.filter((s) => s.direction === 'outbound' && LIVE.has(s.status)).map((s) => s.carrier)),
  ].sort();

  const ruleFor = (carrier: string | null): CodFeeRule | null => {
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
    return best;
  };

  const applied: { readonly exVat: Minor; readonly vat: Minor; readonly cost: Minor; readonly basis: TermBasis }[] = [];

  for (const { payment, index } of legs) {
    // With more than one courier on the order, split the collected cash between
    // them and price each share under its own rate card. Splitting evenly is the
    // honest default: nothing reports which parcel the cash came with.
    const shares =
      carriers.length > 1
        ? allocateMinor(
            payment.amountGrossMinor,
            carriers.map((c) => ({ key: c, weight: ZERO })),
          )
        : new Map<string, Minor>([[carriers[0] ?? '', payment.amountGrossMinor]]);

    for (const [carrier, amount] of shares) {
      const rule = ruleFor(carriers.length === 0 ? null : carrier);
      if (rule === null) {
        diagnostics.push(diagnostic('COD_FEE_RULE_MISSING', { kind: 'payment', index }));
        applied.push({ exVat: ZERO, vat: ZERO, cost: ZERO, basis: 'missing' });
        continue;
      }
      if (rule.source === 'default_table') {
        diagnostics.push(diagnostic('FEE_RULE_DEFAULT_USED', { kind: 'payment', index }));
      }
      const fee = applyFeeFormula(amount, rule, vatRegistered);
      applied.push({
        exVat: fee.exVatMinor,
        vat: fee.vatMinor,
        cost: fee.costMinor,
        basis: basisOfFeeSource(rule.source),
      });
    }
  }

  const basis: TermBasis = applied.some((a) => a.basis === 'missing')
    ? 'missing'
    : applied.some((a) => a.basis === 'estimated')
      ? 'estimated'
      : 'actual';

  return {
    value: {
      exVatMinor: addMinor(...applied.map((a) => a.exVat)),
      vatMinor: addMinor(...applied.map((a) => a.vat)),
      costMinor: addMinor(...applied.map((a) => a.cost)),
      basis,
    },
    diagnostics,
  };
}
