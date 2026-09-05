import type { OrderProfitInput } from './input.js';
import type { OrderProfitResult } from './result.js';
import { NotImplementedError } from './not-implemented.js';

/**
 * THE signature. Everything else in this package exists to describe its input
 * and its output.
 *
 * ## Contract
 *
 * **Pure.** No I/O, no database, no clock, no randomness. Every input is passed
 * explicitly, including the store's timezone and the fee rules in force. Called
 * twice with the same input, it returns the same result — forever, for a given
 * `CALC_VERSION`.
 *
 * **Total.** It never throws, for any input. The argument is not aesthetic:
 * webhooks are queued and ingestion owns retry, so a throw is indistinguishable
 * from a transient failure. A permanently uncosted SKU would become a
 * deterministic retry storm that also delays healthy jobs, and the order would
 * vanish from the merchant's dashboard entirely — strictly worse than a flagged
 * estimate. Input defects that indicate a *caller* bug return
 * `status: 'rejected'` instead, which is a machine-readable dead-letter signal
 * and, unlike an exception, snapshot-testable in a golden fixture.
 *
 * A `Result`/`Either` union was rejected for a different reason: it collapses
 * partial success. An order with nine costed lines and one uncosted is 90%
 * useful, and every caller would branch identically, so the branch buys nothing.
 *
 * ## The formula
 *
 * ```
 * revenue_ex_vat  = Σ(line revenue, after allocated order discounts)
 *                 + shipping charged (ex VAT)
 *                 + COD fee charged (ex VAT)
 *
 * cogs            = Σ(quantity × cost snapshotted at ingestion)
 *
 * shipping_cost   = Σ(outbound carrier cost)  ?? zone fallback rule
 * return_shipping = Σ(return carrier cost)    ?? zone fallback rule
 *
 * gateway_fee     = Σ over captured payment legs:
 *                     clamp(mulBps(gross, percentBps) + fixed, min, max), plus fee VAT
 *
 * cod_cost        = the same formula, keyed by carrier
 *
 * reversal_impact = − reversed revenue
 *                   + restocked COGS   (only where the goods actually came back sellable)
 *                   // outbound shipping and gateway fees stay sunk; a refunded
 *                   // order still paid to ship and still paid to collect
 *
 * margin          = revenue_ex_vat − cogs − shipping_cost − return_shipping
 *                   − gateway_fee − cod_cost + reversal_impact
 * ```
 *
 * VAT is excluded from revenue entirely — it is the government's money passing
 * through. It is *not* excluded from the cost side for a merchant who is not
 * VAT-registered, because they cannot reclaim it.
 *
 * ## Invariants, asserted by every golden fixture
 *
 * ```
 * revenueExVatMinor  === items + shipping + codFee − orderDiscount
 * contributionMargin === revenue − cogs − outboundShipping − returnShipping
 *                        − gatewayFee − codCost + reversalImpact
 * Σ(lines.contributionMarginMinor) === totals.contributionMarginMinor   EXACTLY
 * Σ(lines.cogsMinor)               === totals.cogsMinor                 EXACTLY
 * Number.isSafeInteger(x) for every money field
 * ```
 *
 * The per-line sums must tie exactly, not approximately. If order profit and the
 * sum of its SKU profits disagree by a halala, a merchant will eventually notice,
 * and at that point every other number on the page is in question.
 *
 * ## Planned decomposition
 *
 * A thin orchestrator over named pure functions, each returning its value
 * alongside the diagnostics it produced — so provenance is recorded where the
 * fact is known rather than reconstructed afterwards. No sub-function takes the
 * whole `OrderProfitInput`; that would recreate the coupling the split exists to
 * remove.
 *
 * 1. `normalizeAndValidate`      — fatal checks; the only path to `rejected`
 * 2. `computeRecognition`        — the three status axes → `ProfitRecognition`
 * 3. `computeLineRevenue`        — allocate order-level item discounts to lines
 * 4. `computeRevenue`            — add shipping and COD fee; run the reconciliation identity
 * 5. `computeCogs`               — resolve by product key, then by SKU; a miss contributes 0 and flags
 * 6. `computeShippingCost`       — actual carrier cost, else the fallback rule; gated on fulfilment method
 * 7. `computeGatewayFees`        — captured legs only; specificity match; clamp; split VAT
 * 8. `computeCodCost`            — the same shape, keyed by carrier
 * 9. `computeReversalImpact`     — reported reversal lines, else allocate by revenue share and flag it
 * 10. `allocateOrderCostsToLines` — largest remainder, so per-SKU sums tie exactly
 * 11. `deriveConfidence`         — a pure projection of the diagnostics
 *
 * Only `computeOrderProfit` carries a stability guarantee. The rest may be
 * reshaped freely, provided the golden fixtures still pass.
 */
export function computeOrderProfit(_input: Readonly<OrderProfitInput>): OrderProfitResult {
  throw new NotImplementedError('computeOrderProfit');
}

/** The signature as a first-class type, so a fake or a decorated variant is checkable against it. */
export type ComputeOrderProfit = (input: Readonly<OrderProfitInput>) => OrderProfitResult;
