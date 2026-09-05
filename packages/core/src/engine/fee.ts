import { toMinor } from '@ghalla/contracts';
import type { Minor } from '@ghalla/contracts';
import type { FeeFormula } from '../fee-rules.js';
import type { TermBasis } from '../confidence.js';
import { addMinor, clampMinor, mulBps, splitVatInclusive, subMinor } from '../money.js';

export interface AppliedFee {
  readonly exVatMinor: Minor;
  readonly vatMinor: Minor;
  /** What the merchant actually loses: ex-VAT, plus the VAT if they cannot reclaim it. */
  readonly costMinor: Minor;
}

export const NO_FEE: AppliedFee = { exVatMinor: toMinor(0), vatMinor: toMinor(0), costMinor: toMinor(0) };

/**
 * One formula for every fee-like cost, because they are the same arithmetic
 * with different keys.
 *
 * Two things a naive percentage misses, both systematic rather than marginal:
 *
 * The clamp. Domestic debit is commonly priced as a percentage capped per
 * transaction, and couriers quote a percentage with a floor. Uncapped, every
 * high-value order is overcharged — rare at a typical basket size, concentrated
 * in furniture and electronics, and the first order a merchant checks against
 * their statement.
 *
 * The VAT. Saudi law taxes explicit fees and commissions, so omitting it
 * understates gateway cost by 15% on every card order, uniformly, in the
 * direction that flatters margin. Whether the merchant gets it back depends on
 * their registration, which is why that is a store field and not a constant.
 */
export function applyFeeFormula(base: Minor, formula: FeeFormula, vatRegistered: boolean): AppliedFee {
  const raw = addMinor(mulBps(base, formula.percentBps), formula.fixedMinor);
  const clamped = clampMinor(raw, formula.minFeeMinor, formula.maxFeeMinor);

  const exVatMinor = formula.ratesIncludeVat
    ? splitVatInclusive(clamped, formula.feeVatBps).net
    : clamped;
  const vatMinor = formula.ratesIncludeVat
    ? subMinor(clamped, exVatMinor)
    : mulBps(clamped, formula.feeVatBps);

  return {
    exVatMinor,
    vatMinor,
    costMinor: vatRegistered ? exVatMinor : addMinor(exVatMinor, vatMinor),
  };
}

/**
 * A rate the merchant typed in is `estimated` even when it is their real
 * contract: it is a rule applied to an order rather than the amount that order
 * was actually charged. Only a processor's own statement is `actual`.
 *
 * That line is the product's honesty budget. Estimated means we used your rate
 * card; missing means we are guessing at zero.
 */
export function basisOfFeeSource(source: FeeFormula['source']): TermBasis {
  return source === 'gateway_statement' ? 'actual' : 'estimated';
}
