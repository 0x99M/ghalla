import { toMinor } from '@ghalla/contracts';
import type { CanonicalOrder, Minor, PaymentBreakdown } from '@ghalla/contracts';
import type { Diagnostic } from '../diagnostics.js';
import type { GatewayFeeRule } from '../fee-rules.js';
import type { TermBasis } from '../confidence.js';
import { addMinor } from '../money.js';
import { applyFeeFormula, basisOfFeeSource } from './fee.js';
import type { AppliedFee } from './fee.js';
import { diagnostic } from './diagnostics-builder.js';
import type { Computed } from './diagnostics-builder.js';

const ZERO = toMinor(0);

export interface GatewayFees {
  readonly exVatMinor: Minor;
  readonly vatMinor: Minor;
  readonly costMinor: Minor;
  readonly basis: TermBasis;
}

/** Cash on delivery has no gateway; a fully discounted order was never charged. */
const CHARGEABLE = (payment: PaymentBreakdown): boolean =>
  payment.state === 'captured' && payment.instrument !== 'cod' && payment.instrument !== 'free';

function matches(rule: GatewayFeeRule, payment: PaymentBreakdown, scheme: string | null): boolean {
  if (rule.instrument !== null && rule.instrument !== payment.instrument) return false;
  if (rule.scheme !== null && rule.scheme !== scheme) return false;
  if (rule.provider !== null && rule.provider !== payment.provider) return false;
  return true;
}

const specificity = (rule: GatewayFeeRule): number =>
  (rule.instrument !== null ? 4 : 0) + (rule.scheme !== null ? 2 : 0) + (rule.provider !== null ? 1 : 0);

function bestRule(
  rules: readonly GatewayFeeRule[],
  payment: PaymentBreakdown,
  scheme: string | null,
): GatewayFeeRule | null {
  let best: GatewayFeeRule | null = null;
  let bestScore = -1;
  for (const rule of rules) {
    if (!matches(rule, payment, scheme)) continue;
    const score = specificity(rule);
    if (score > bestScore) {
      best = rule;
      bestScore = score;
    }
  }
  return best;
}

/**
 * Processor fees, per captured leg.
 *
 * When the platform will not say which card network was behind a wallet — which
 * it usually will not — every rule that could apply is priced and the MOST
 * EXPENSIVE is taken. The two candidates differ by roughly 3x, so the choice is
 * not cosmetic, and the direction is deliberate: understating a merchant's
 * profit and being corrected is survivable, overstating it and being caught is
 * not. The result is stamped `estimated`, and the dashboard must not flag a
 * loss-maker on a fee-driven margin.
 */
export function computeGatewayFees(
  order: CanonicalOrder,
  rules: readonly GatewayFeeRule[],
  vatRegistered: boolean,
): Computed<GatewayFees> {
  const diagnostics: Diagnostic[] = [];
  const legs = order.payments.filter(CHARGEABLE);

  if (legs.length === 0) {
    return { value: { exVatMinor: ZERO, vatMinor: ZERO, costMinor: ZERO, basis: 'not_applicable' }, diagnostics };
  }

  const captured = addMinor(
    ...order.payments.filter((p) => p.state === 'captured').map((p) => p.amountGrossMinor),
  );
  if (order.paymentState === 'paid' && captured < order.totalIncVatMinor) {
    // Fees are proportional to the legs an adapter actually mapped, so
    // under-mapping always flatters margin.
    diagnostics.push({ code: 'PAYMENT_LEGS_UNDER_TOTAL', severity: 'warning', subject: { kind: 'order' } });
  }

  const applied: AppliedFee[] = [];
  let anyMissing = false;
  let worstBasis: TermBasis = 'actual';

  order.payments.forEach((payment, index) => {
    if (!CHARGEABLE(payment)) return;

    if (payment.instrument === 'unknown' || payment.instrument === 'other') {
      diagnostics.push(diagnostic('UNKNOWN_PAYMENT_INSTRUMENT', { kind: 'payment', index }));
    }

    const schemeUnknown = payment.instrument === 'card' && (payment.scheme === null || payment.scheme === 'unknown');

    let rule: GatewayFeeRule | null;
    if (schemeUnknown) {
      diagnostics.push(diagnostic('CARD_SCHEME_UNKNOWN', { kind: 'payment', index }));
      // Price every scheme this rule set knows for the instrument and provider,
      // and assume the worst of them.
      const candidates = rules.filter((r) => matches(r, payment, r.scheme));
      rule =
        candidates.length === 0
          ? null
          : candidates.reduce((worst, candidate) =>
              applyFeeFormula(payment.amountGrossMinor, candidate, vatRegistered).costMinor >
              applyFeeFormula(payment.amountGrossMinor, worst, vatRegistered).costMinor
                ? candidate
                : worst,
            );
    } else {
      rule = bestRule(rules, payment, payment.scheme);
    }

    if (rule === null) {
      anyMissing = true;
      diagnostics.push(diagnostic('FEE_RULE_MISSING', { kind: 'payment', index }));
      return;
    }

    if (rule.source === 'default_table') {
      diagnostics.push(diagnostic('FEE_RULE_DEFAULT_USED', { kind: 'payment', index }));
    }

    const basis = schemeUnknown ? 'estimated' : basisOfFeeSource(rule.source);
    if (basis === 'estimated' && worstBasis === 'actual') worstBasis = 'estimated';

    applied.push(applyFeeFormula(payment.amountGrossMinor, rule, vatRegistered));
  });

  const exVatMinor = addMinor(...applied.map((a) => a.exVatMinor));
  const vatMinor = addMinor(...applied.map((a) => a.vatMinor));
  const costMinor = addMinor(...applied.map((a) => a.costMinor));

  return {
    value: { exVatMinor, vatMinor, costMinor, basis: anyMissing ? 'missing' : worstBasis },
    diagnostics,
  };
}
