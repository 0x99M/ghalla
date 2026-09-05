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
 * A projection of the per-term facts the sub-functions established — the same
 * facts the diagnostics were built from, so the two are siblings rather than
 * one derived from the other.
 *
 * They can still drift, and did: a warning diagnostic used to coexist happily
 * with `level: 'exact'`, badging a number as definitive while a note beside it
 * said the inputs were incomplete. The fix is not to parse diagnostics into
 * confidence, which would invert the dependency — it is to make sure every
 * diagnostic that means "this number is less trustworthy" also moves a term.
 * The ones that used to move nothing are handled here.
 *
 * `level` is denormalized purely as a filter and index column. The hard rule it
 * exists to serve: loss-maker ranking must exclude `incomplete` rows, because a
 * margin computed with a missing input is a bound, not a number.
 */
export function deriveConfidence(terms: TermBases, diagnostics: readonly Diagnostic[]): ProfitConfidence {
  const has = (code: string): boolean => diagnostics.some((d) => d.code === code);
  const worse = (basis: TermBasis, floor: TermBasis): TermBasis =>
    basis === 'actual' || basis === 'not_applicable' ? floor : basis;
  // A restock we could not confirm makes the COGS credit a guess, not a fact.
  const cogs = has('RESTOCK_UNKNOWN') ? worse(terms.cogs, 'estimated') : terms.cogs;
  const reversal: ProfitConfidence['reversal'] =
    has('REVERSAL_LINE_UNMATCHED') || has('REVERSAL_TOTAL_MISMATCH')
      ? 'allocated'
      : terms.reversal;

  const bases: readonly TermBasis[] = [
    cogs,
    terms.outboundShipping,
    terms.returnShipping,
    terms.gatewayFee,
    terms.codCost,
  ];

  // An order whose items failed to ingest has revenue we cannot vouch for.
  const revenue: ProfitConfidence['revenue'] =
    terms.reconciles && !has('ORDER_HAS_NO_ITEMS') ? 'reported' : 'unreconciled';
  const anyMissing = bases.includes('missing');
  const allSettled = bases.every((b) => b === 'actual' || b === 'not_applicable');

  const level: ProfitConfidence['level'] = anyMissing || revenue === 'unreconciled'
    ? 'incomplete'
    : allSettled && reversal !== 'allocated'
      ? 'exact'
      : 'estimated';

  return {
    revenue,
    cogs,
    outboundShipping: terms.outboundShipping,
    returnShipping: terms.returnShipping,
    gatewayFee: terms.gatewayFee,
    codCost: terms.codCost,
    reversal,
    level,
  };
}
