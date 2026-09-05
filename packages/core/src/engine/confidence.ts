import type { Diagnostic } from '../diagnostics.js';
import type { ProfitConfidence, TermBasis } from '../confidence.js';

export interface TermBases {
  readonly reconciles: boolean;
  readonly cogs: TermBasis;
  readonly outboundShipping: TermBasis;
  readonly returnShipping: TermBasis;
  readonly gatewayFee: TermBasis;
  readonly codCost: TermBasis;
  readonly reversal: ProfitConfidence['reversal'];
}

/**
 * A PURE PROJECTION of what the sub-functions already established.
 *
 * Confidence and diagnostics are two views of one fact. Deriving one from the
 * other rather than maintaining both is what stops a dashboard badge from
 * disagreeing with the explanation printed beside it.
 *
 * `level` is denormalized purely as a filter and index column. The hard rule it
 * exists to serve: loss-maker ranking must exclude `incomplete` rows, because
 * a margin computed with a missing input is a bound, not a number.
 */
export function deriveConfidence(terms: TermBases, _diagnostics: readonly Diagnostic[]): ProfitConfidence {
  const bases: readonly TermBasis[] = [
    terms.cogs,
    terms.outboundShipping,
    terms.returnShipping,
    terms.gatewayFee,
    terms.codCost,
  ];

  const revenue: ProfitConfidence['revenue'] = terms.reconciles ? 'reported' : 'unreconciled';
  const anyMissing = bases.includes('missing');
  const allSettled = bases.every((b) => b === 'actual' || b === 'not_applicable');

  const level: ProfitConfidence['level'] = anyMissing || revenue === 'unreconciled'
    ? 'incomplete'
    : allSettled && terms.reversal !== 'allocated'
      ? 'exact'
      : 'estimated';

  return {
    revenue,
    cogs: terms.cogs,
    outboundShipping: terms.outboundShipping,
    returnShipping: terms.returnShipping,
    gatewayFee: terms.gatewayFee,
    codCost: terms.codCost,
    reversal: terms.reversal,
    level,
  };
}
