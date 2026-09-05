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
 * What each basis means for the two terms no platform reports.
 *
 * `actual` requires a settled figure: a courier's charge on the shipment, or a
 * processor's own statement. A rate the merchant typed in is `estimated` even
 * when it is their real contract, because it is a rule applied to an order
 * rather than the amount that order was actually charged. A published default
 * we shipped is `estimated` too, and additionally carries
 * `FEE_RULE_DEFAULT_USED` so the dashboard can say "confirm these".
 *
 * That distinction is the product's honesty budget: estimated means we used
 * your rate card, missing means we are guessing at zero.
 */

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
  /**
   * `unreconciled` — the order's own totals identity failed, so the revenue
   * figure is the adapter's arithmetic rather than the merchant's.
   *
   * There is deliberately no `derived` member. It would mean "an ex-VAT
   * component was extracted from a gross figure rather than reported", which is
   * adapter knowledge the canonical types carry no signal for — so the engine
   * could never produce it, and a permanently unreachable enum member is a lie
   * about what the system knows. Adding it later, with the signal, is additive.
   */
  readonly revenue: 'reported' | 'unreconciled';
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
