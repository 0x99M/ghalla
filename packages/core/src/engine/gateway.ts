import { toMinor } from '@ghalla/contracts';
import type { CanonicalOrder, Minor, PaymentBreakdown } from '@ghalla/contracts';
import type { Diagnostic } from '../diagnostics.js';
import type { GatewayFeeRule } from '../fee-rules.js';
import type { TermBasis } from '../confidence.js';
import { addMinor } from '../money.js';
import { applyFeeFormula, basisOfFeeSource } from './fee.js';
import type { AppliedFee } from './fee.js';
import { diagnostic, onOrder } from './diagnostics-builder.js';
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
    if (specificity(rule) > bestScore) {
      best = rule;
      bestScore = specificity(rule);
    }
  }
  return best;
}

/**
 * Every rule that could plausibly price this leg if the scheme were known.
 *
 * Written out explicitly rather than reusing `matches` with the rule's own
 * scheme as the scheme to compare against — that predicate reduces to
 * `r.scheme !== r.scheme`, which is always false, so the scheme axis filtered
 * nothing and an instrument-agnostic catch-all could outbid the merchant's own
 * card table by 3.4x.
 */
function schemeCandidates(rules: readonly GatewayFeeRule[], payment: PaymentBreakdown): readonly GatewayFeeRule[] {
  const eligible = rules.filter(
    (r) =>
      r.instrument === payment.instrument &&
      (r.provider === null || r.provider === payment.provider),
  );
  if (eligible.length === 0) return [];
  // Degrade from bestRule rather than replacing it: compare only within the most
  // specific tier that actually applies, so a provider-keyed table still wins.
  const top = Math.max(...eligible.map(specificity));
  return eligible.filter((r) => specificity(r) === top);
}

/**
 * Processor fees, per captured leg.
 *
 * When the platform will not say which card network was behind a wallet — which
 * it usually will not — every candidate rule is priced and the MOST EXPENSIVE is
 * taken. The two candidates differ by roughly 3x, so the choice is not
 * cosmetic, and the direction is deliberate: understating a merchant's profit
 * and being corrected is survivable, overstating it and being caught is not.
 * The result is stamped `estimated`, and the dashboard must not flag a
 * loss-maker on a fee-driven margin.
 */
export function computeGatewayFees(
  order: CanonicalOrder,
  rules: readonly GatewayFeeRule[],
  vatRegistered: boolean,
): Computed<GatewayFees> {
  const diagnostics: Diagnostic[] = [];

  // Checked BEFORE the no-chargeable-legs return. An order the platform calls
  // paid whose legs are entirely unmapped would otherwise report a zero fee at
  // confidence `exact` — the partially-mapped case was warned and the totally
  // unmapped one was silent, which is backwards.
  const captured = addMinor(
    ...order.payments.filter((p) => p.state === 'captured').map((p) => p.amountGrossMinor),
  );
  const underMapped = order.paymentState === 'paid' && captured < order.totalIncVatMinor;
  if (underMapped) diagnostics.push(onOrder('PAYMENT_LEGS_UNDER_TOTAL'));

  const legs = order.payments.filter(CHARGEABLE);
  if (legs.length === 0) {
    return {
      value: {
        exVatMinor: ZERO,
        vatMinor: ZERO,
        costMinor: ZERO,
        // `missing` rather than `not_applicable`: a paid order with no captured
        // leg has a fee we failed to see, not a fee that does not exist.
        basis: underMapped ? 'missing' : 'not_applicable',
      },
      diagnostics,
    };
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
      const candidates = schemeCandidates(rules, payment);
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

  const basis: TermBasis = anyMissing || underMapped ? 'missing' : worstBasis;

  return {
    value: {
      exVatMinor: addMinor(...applied.map((a) => a.exVatMinor)),
      vatMinor: addMinor(...applied.map((a) => a.vatMinor)),
      costMinor: addMinor(...applied.map((a) => a.costMinor)),
      basis,
    },
    diagnostics,
  };
}
