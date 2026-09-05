import { toBps, toMinor } from '@ghalla/contracts';
import type { Bps, Minor, OrderId, OrderItemId, StoreId } from '@ghalla/contracts';
import { CALC_VERSION } from './calc-version.js';
import type { Diagnostic, DiagnosticCode } from './diagnostics.js';
import type { OrderProfitInput } from './input.js';
import type { OrderProfitLine, OrderProfitResult, OrderProfitTotals } from './result.js';
import { addMinor, divRoundHalfAway, subMinor } from './money.js';
import { onOrder, sortDiagnostics } from './engine/diagnostics-builder.js';
import { normalizeAndValidate } from './engine/normalize.js';
import { DISPATCHED, computeRecognition } from './engine/recognition.js';
import { computeRevenue } from './engine/revenue.js';
import { computeCogs } from './engine/cogs.js';
import { computeShippingCost } from './engine/shipping.js';
import { computeGatewayFees } from './engine/gateway.js';
import { computeCodCost } from './engine/cod.js';
import { computeReversalImpact } from './engine/reversal.js';
import { allocateOrderCostsToLines } from './engine/allocate-lines.js';
import { deriveConfidence } from './engine/confidence.js';
import { InvalidTimezoneError, MalformedInstantError, businessDateOf } from './engine/business-date.js';

const ZERO = toMinor(0);

/**
 * THE function. Everything else in this package exists to describe its input,
 * its output, or one step of its arithmetic.
 *
 * ## Contract
 *
 * **Pure.** No I/O, no database, no clock, no randomness. Every input is passed
 * explicitly, including the store's timezone and the fee rules in force. Called
 * twice with the same input it returns the same result — forever, for a given
 * `CALC_VERSION`.
 *
 * **Total.** It never throws, for any input — including `null`, a missing
 * `order`, or money fields that arrive as strings. The argument is not
 * aesthetic: webhooks are queued and ingestion owns retry, so a throw is
 * indistinguishable from a transient failure. A permanently uncosted SKU would
 * become a deterministic retry storm that also delays healthy jobs, and the
 * order would vanish from the merchant's dashboard entirely — strictly worse
 * than a flagged estimate. Defects that indicate a *caller* bug return
 * `status: 'rejected'` instead, which is a machine-readable dead-letter signal
 * and, unlike an exception, snapshot-testable in a golden fixture.
 *
 * ## The formula
 *
 * ```
 * revenue_ex_vat  = Σ(line revenue) + shipping charged + COD fee charged
 *                   − order-level discounts not already reflected
 *
 * cogs            = Σ(quantity × cost snapshotted at ingestion)
 *
 * shipping_cost   = Σ(outbound carrier cost)  ?? zone fallback rule
 * return_shipping = Σ(return carrier cost)    ?? zone fallback rule
 *
 * gateway_fee     = Σ over captured legs: clamp(gross × bps + fixed, min, max), plus fee VAT
 * cod_cost        = the same formula, keyed by carrier, on captured COD legs only
 *
 * reversal_impact = − reversed revenue + restocked COGS
 *
 * margin          = revenue_ex_vat − cogs − shipping_cost − return_shipping
 *                   − gateway_fee − cod_cost + reversal_impact
 * ```
 *
 * VAT is excluded from revenue entirely — it is the government's money passing
 * through. On the cost side it is excluded only for a VAT-registered merchant,
 * and only from the fees this engine computes: courier cost arrives already on
 * the correct basis (see `CanonicalShipment.carrierCostMinor`).
 *
 * ## Invariants, asserted by every golden fixture
 *
 * ```
 * revenueExVatMinor  === items + shipping + codFee − orderDiscount
 * contributionMargin === revenue − cogs − outboundShipping − returnShipping
 *                        − gatewayFee − codCost + reversalImpact
 * Σ(lines.contributionMarginMinor) === totals.contributionMarginMinor   EXACTLY
 * Σ(lines.cogsMinor)               === totals.cogsMinor                 EXACTLY
 * restockedCogsMinor <= cogsMinor    (you cannot get back more than you shipped)
 * Number.isSafeInteger(x) for every money field
 * ```
 *
 * The per-line ties hold whenever there is at least one line. An order with no
 * items keeps its order-level amounts in the totals and reports
 * `ORDER_HAS_NO_ITEMS`; there is nothing to tie to.
 */
export function computeOrderProfit(input: Readonly<OrderProfitInput>): OrderProfitResult {
  // Read BEFORE the try. The reject builder used to dereference these, so seven
  // malformed inputs escaped as an uncaught TypeError out of the very handler
  // that exists to guarantee they cannot.
  const orderId = (input?.order?.id ?? '') as OrderId;
  const storeId = (input?.store?.storeId ?? '') as StoreId;

  const reject = (code: DiagnosticCode): OrderProfitResult => ({
    status: 'rejected',
    orderId,
    storeId,
    calcVersion: CALC_VERSION,
    diagnostics: [onOrder(code)],
  });

  try {
    return compute(input, orderId, storeId);
  } catch (error) {
    // Totality is a promise, so it cannot rest on every internal invariant
    // holding. A bug here is dead-lettered as a rejected result rather than
    // thrown into a queue that would retry it forever.
    if (error instanceof MalformedInstantError) return reject('MALFORMED_TIMESTAMP');
    if (error instanceof InvalidTimezoneError) return reject('INVALID_TIMEZONE');
    return reject('INTERNAL_INVARIANT_VIOLATED');
  }
}

function compute(input: Readonly<OrderProfitInput>, orderId: OrderId, storeId: StoreId): OrderProfitResult {
  const { normalized, diagnostics: fatal } = normalizeAndValidate(input);
  if (normalized === null) {
    return {
      status: 'rejected',
      orderId,
      storeId,
      calcVersion: CALC_VERSION,
      diagnostics: sortDiagnostics(fatal),
    };
  }

  const { order, items, shipments, reversals, costs } = normalized;
  const { store, feeRuleSet } = input;
  const diagnostics: Diagnostic[] = [];

  const recognition = computeRecognition(order, shipments);
  const businessDate = businessDateOf(order.placedAt, store.timezone);

  const revenue = computeRevenue(order, items, recognition);
  diagnostics.push(...revenue.diagnostics);

  const cogs = computeCogs(items, costs);
  diagnostics.push(...cogs.diagnostics);

  const outbound = computeShippingCost(order, shipments, feeRuleSet.shippingFallback, 'outbound');
  diagnostics.push(...outbound.diagnostics);

  const returned = computeShippingCost(order, shipments, feeRuleSet.shippingFallback, 'return');
  diagnostics.push(...returned.diagnostics);

  const gateway = computeGatewayFees(order, feeRuleSet.gateway, store.vatRegistered);
  diagnostics.push(...gateway.diagnostics);

  const cod = computeCodCost(order, shipments, feeRuleSet.cod, store.vatRegistered);
  diagnostics.push(...cod.diagnostics);

  const quantities = new Map<OrderItemId, number>(items.map((i) => [i.id, i.quantity]));
  // Weights come from the ITEMS, so they survive a cost_only order zeroing
  // recognized revenue — otherwise every order-level cost splits evenly and a
  // cheap accessory carries the same courier charge as an expensive item.
  const weights = new Map<OrderItemId, Minor>(items.map((i) => [i.id, i.lineTotalExVatMinor]));
  const reversal = computeReversalImpact(
    reversals,
    revenue.value.lines,
    cogs.value.lines,
    quantities,
    weights,
    recognition,
    shipments,
    DISPATCHED.has(order.fulfillmentState),
  );
  diagnostics.push(...reversal.diagnostics);

  const excluded = recognition.kind === 'excluded';

  // For an excluded order nothing is recognized at all, not even the costs.
  const outboundCost = excluded ? ZERO : outbound.value.costMinor;
  const returnCost = excluded ? ZERO : returned.value.costMinor;
  const gatewayCost = excluded ? ZERO : gateway.value.costMinor;
  const codCost = excluded ? ZERO : cod.value.costMinor;
  const cogsCost = excluded ? ZERO : cogs.value.cogsMinor;

  const lines: readonly OrderProfitLine[] = excluded
    ? []
    : allocateOrderCostsToLines(items, revenue.value.lines, cogs.value.lines, reversal.value.lines, {
        // Discounts targeting shipping or the COD fee reduce those terms rather
        // than item revenue. They come from computeRevenue, which has already
        // zeroed them on a non-recognized order — reading order.discounts again
        // here was a second source of truth, and it broke the per-line tie by
        // exactly the discount on any cost_only order with a free-shipping coupon.
        shippingRevenueExVatMinor: subMinor(
          revenue.value.shippingRevenueExVatMinor,
          revenue.value.shippingDiscountExVatMinor,
        ),
        codFeeRevenueExVatMinor: subMinor(
          revenue.value.codFeeRevenueExVatMinor,
          revenue.value.codFeeDiscountExVatMinor,
        ),
        outboundParcels: outbound.value.parcels,
        returnParcels: returned.value.parcels,
        outboundShippingCostMinor: outboundCost,
        returnShippingCostMinor: returnCost,
        gatewayFeeCostMinor: gatewayCost,
        codCostMinor: codCost,
      });

  const contributionMargin = subMinor(
    addMinor(revenue.value.revenueExVatMinor, excluded ? ZERO : reversal.value.impactMinor),
    addMinor(cogsCost, outboundCost, returnCost, gatewayCost, codCost),
  );

  const totals: OrderProfitTotals = {
    itemsRevenueExVatMinor: revenue.value.itemsRevenueExVatMinor,
    shippingRevenueExVatMinor: revenue.value.shippingRevenueExVatMinor,
    codFeeRevenueExVatMinor: revenue.value.codFeeRevenueExVatMinor,
    orderDiscountExVatMinor: revenue.value.orderDiscountExVatMinor,
    revenueExVatMinor: revenue.value.revenueExVatMinor,
    vatCollectedMinor: revenue.value.vatCollectedMinor,

    cogsMinor: cogsCost,
    outboundShippingCostMinor: outboundCost,
    returnShippingCostMinor: returnCost,

    gatewayFeeExVatMinor: excluded ? ZERO : gateway.value.exVatMinor,
    gatewayFeeVatMinor: excluded ? ZERO : gateway.value.vatMinor,
    gatewayFeeCostMinor: gatewayCost,
    codCostExVatMinor: excluded ? ZERO : cod.value.exVatMinor,
    codCostVatMinor: excluded ? ZERO : cod.value.vatMinor,
    codCostMinor: codCost,

    reversedRevenueExVatMinor: excluded ? ZERO : reversal.value.reversedRevenueExVatMinor,
    restockedCogsMinor: excluded ? ZERO : reversal.value.restockedCogsMinor,
    reversalImpactMinor: excluded ? ZERO : reversal.value.impactMinor,

    contributionMarginMinor: contributionMargin,
    marginBps: marginBpsOf(contributionMargin, revenue.value.revenueExVatMinor),
    costCoveredRevenueExVatMinor: addMinor(...lines.map((l) => l.costCoveredRevenueExVatMinor)),
  };

  const confidence = deriveConfidence(
    {
      reconciles: revenue.value.reconciles,
      cogs: excluded
        ? 'not_applicable'
        : items.length === 0
          ? 'not_applicable'
          : cogs.value.anyMissing
            ? 'missing'
            : // A COGS credit inferred from a shipment status rather than
              // reported is a guess, however well-founded, so such an order can
              // never be `exact`. There is no condition signal on a return leg.
              cogs.value.anyEstimated || reversal.value.inferredRestock
              ? 'estimated'
              : 'actual',
      outboundShipping: excluded ? 'not_applicable' : outbound.value.basis,
      returnShipping: excluded ? 'not_applicable' : returned.value.basis,
      gatewayFee: excluded ? 'not_applicable' : gateway.value.basis,
      codCost: excluded ? 'not_applicable' : cod.value.basis,
      // An RTO has no reversal record at all — the evidence is a shipment — so
      // it stays `not_applicable` rather than claiming a platform reported one.
      reversal: reversals.length === 0 ? 'not_applicable' : reversal.value.allocated ? 'allocated' : 'reported',
    },
    diagnostics,
  );

  return {
    status: 'computed',
    orderId: order.id,
    storeId: store.storeId,
    currency: store.currency,
    businessDate,
    calcVersion: CALC_VERSION,
    feeRuleSetId: feeRuleSet.id,
    recognition,
    totals,
    lines,
    confidence,
    diagnostics: sortDiagnostics(diagnostics),
  };
}

/**
 * `null` rather than zero when there is no revenue: a ratio to nothing is
 * nothing, not 0%. Uses the kernel's rounding, so the rate rounds the same way
 * as the money it describes rather than through a hand-rolled copy.
 */
function marginBpsOf(margin: Minor, revenue: Minor): Bps | null {
  if (revenue <= 0) return null;
  return toBps(divRoundHalfAway(margin * 10_000, revenue));
}

/** The signature as a first-class type, so a fake or a decorated variant is checkable against it. */
export type ComputeOrderProfit = (input: Readonly<OrderProfitInput>) => OrderProfitResult;

/**
 * The one gate that must not be re-implemented per consumer.
 *
 * A margin computed with a missing input is a bound, not a number: an uncosted
 * SKU contributes zero COGS and therefore reports as the most profitable
 * product in the catalogue. Loss-maker ranking, and any "worst products" view,
 * must filter on this.
 */
export function isRankableForLossMaker(result: OrderProfitResult): boolean {
  return (
    result.status === 'computed' &&
    result.confidence.level !== 'incomplete' &&
    result.recognition.kind !== 'excluded'
  );
}
