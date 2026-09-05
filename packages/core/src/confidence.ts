/**
 * How a term was arrived at.
 *
 * `missing` is deliberately distinct from `estimated`, and the distinction is
 * directional. A missing cost contributes zero to COGS and therefore
 * OVERSTATES profit — an uncosted SKU reports as the most profitable product in
 * the catalogue, on day one of every install, in the exact feature where being
 * wrong is worst. An estimated cost is centred and merely imprecise. Collapsing
 * the two hides the one that actually misleads.
 */
export type TermBasis = 'actual' | 'estimated' | 'missing' | 'not_applicable';

/**
 * Per-term provenance, with a flat level derived from it.
 *
 * A single four-value enum is a flattened 2×2 over what are already six
 * independent axes; a seventh term would need 2^n members, and each widening
 * invalidates every materialized row. It is also uninformative in practice —
 * neither platform in scope exposes courier cost or gateway fees anywhere, so
 * every order would land on the same value while the merchant's remedy differs
 * completely by component: "enter your COGS" and "enter your courier rate card"
 * and "nothing you can do, this is a platform limitation" are three different
 * conversations.
 *
 * This record is a PURE PROJECTION of the diagnostics. Two channels that must
 * agree, derived from one, cannot drift.
 */
export interface ProfitConfidence {
  /** `derived` — an ex-VAT component was extracted rather than reported. `unreconciled` — the totals identity failed. */
  readonly revenue: 'reported' | 'derived' | 'unreconciled';
  readonly cogs: TermBasis;
  readonly outboundShipping: TermBasis;
  readonly returnShipping: TermBasis;
  readonly gatewayFee: TermBasis;
  readonly codCost: TermBasis;
  readonly reversal: 'reported' | 'allocated' | 'not_applicable';
  /**
   * Denormalized purely as a filter and index column:
   *
   * - `incomplete` — any term is `missing`, or revenue is `unreconciled`
   * - `exact`      — every term is `actual` or `not_applicable`, revenue is
   *                  `reported`, and no reversal was allocated
   * - `estimated`  — otherwise
   *
   * Loss-maker flagging MUST ignore `incomplete` rows. The margin there is a
   * bound, not a number. That gate is what keeps `estimated` honest: estimated
   * means we used the merchant's rate card, incomplete means we are guessing at
   * zero.
   */
  readonly level: 'exact' | 'estimated' | 'incomplete';
}
