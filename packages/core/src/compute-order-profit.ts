import { toBps, toMinor } from '@ghalla/contracts';
import type { Bps, Minor, OrderItemId } from '@ghalla/contracts';
import { CALC_VERSION } from './calc-version.js';
import type { Diagnostic } from './diagnostics.js';
import type { OrderProfitInput } from './input.js';
import type { OrderProfitLine, OrderProfitResult, OrderProfitTotals } from './result.js';
import { addMinor, subMinor } from './money.js';
import { onOrder, sortDiagnostics } from './engine/diagnostics-builder.js';
import { normalizeAndValidate } from './engine/normalize.js';
import { computeRecognition } from './engine/recognition.js';
import { computeRevenue, targetedDiscounts } from './engine/revenue.js';
import { computeCogs } from './engine/cogs.js';
import { computeShippingCost } from './engine/shipping.js';
import { computeGatewayFees } from './engine/gateway.js';
import { computeCodCost } from './engine/cod.js';
import { computeReversalImpact } from './engine/reversal.js';
import { allocateOrderCostsToLines } from './engine/allocate-lines.js';
import { deriveConfidence } from './engine/confidence.js';
import { InvalidTimezoneError, businessDateOf } from './engine/business-date.js';

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
 * **Total.** It never throws, for any input. The argument is not aesthetic:
 * webhooks are queued and ingestion owns retry, so a throw is indistinguishable
 * from a transient failure. A permanently uncosted SKU would become a
 * deterministic retry storm that also delays healthy jobs, and the order would
 * vanish from the merchant's dashboard entirely — strictly worse than a flagged
 * estimate. Defects that indicate a *caller* bug return `status: 'rejected'`
 * instead, which is a machine-readable dead-letter signal and, unlike an
 * exception, snapshot-testable in a golden fixture.
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
 * through. It is NOT excluded from the cost side for a merchant who is not
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
 * The per-line ties hold whenever there is at least one line. An order with no
 * items keeps its order-level amounts in the totals and reports
 * `ORDER_HAS_NO_ITEMS`; there is nothing to tie to.
 */
export function computeOrderProfit(input: Readonly<OrderProfitInput>): OrderProfitResult {
  try {
    return compute(input);
  } catch (error) {
    // Totality is a promise, so it cannot depend on every internal invariant
    // holding. A bug here is dead-lettered as a rejected result rather than
    // thrown into a queue that would retry it forever.
    const code = error instanceof InvalidTimezoneError ? 'INVALID_TIMEZONE' : 'INTERNAL_INVARIANT_VIOLATED';
    return {
      status: 'rejected',
      orderId: input.order.id,
      storeId: input.store.storeId,
      calcVersion: CALC_VERSION,
      diagnostics: [onOrder(code)],
    };
  }
}

function compute(input: Readonly<OrderProfitInput>): OrderProfitResult {
  const { normalized, diagnostics: fatal } = normalizeAndValidate(input);
  if (normalized === null) {
    return {
      status: 'rejected',
      orderId: input.order.id,
      storeId: input.store.storeId,
      calcVersion: CALC_VERSION,
      diagnostics: sortDiagnostics(fatal),
    };
  }

  const { order, items, shipments, reversals, costs } = normalized;
  const { store, feeRuleSet } = input;
  const diagnostics: Diagnostic[] = [];

  const recognition = computeRecognition(order);
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
  const reversal = computeReversalImpact(
    reversals,
    revenue.value.lines,
    cogs.value.lines,
    quantities,
    recognition,
    shipments,
  );
  diagnostics.push(...reversal.diagnostics);

  const excluded = recognition.kind === 'excluded';
  const targeted = targetedDiscounts(order);

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
        // than item revenue, so they are netted off here and not allocated to
        // lines as item discounts.
        shippingRevenueExVatMinor: subMinor(revenue.value.shippingRevenueExVatMinor, targeted.shipping),
        codFeeRevenueExVatMinor: subMinor(revenue.value.codFeeRevenueExVatMinor, targeted.codFee),
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
            : cogs.value.anyEstimated
              ? 'estimated'
              : 'actual',
      outboundShipping: excluded ? 'not_applicable' : outbound.value.basis,
      returnShipping: excluded ? 'not_applicable' : returned.value.basis,
      gatewayFee: excluded ? 'not_applicable' : gateway.value.basis,
      codCost: excluded ? 'not_applicable' : cod.value.basis,
      reversal:
        reversals.length === 0 && reversal.value.impactMinor === 0
          ? 'not_applicable'
          : reversal.value.allocated
            ? 'allocated'
            : 'reported',
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

/** `null` rather than zero when there is no revenue: a ratio to nothing is nothing, not 0%. */
function marginBpsOf(margin: Minor, revenue: Minor): Bps | null {
  if (revenue <= 0) return null;
  const scaled = margin * 10_000;
  if (!Number.isSafeInteger(scaled)) return null;
  const negative = scaled < 0;
  const abs = negative ? -scaled : scaled;
  const whole = Math.floor(abs / revenue);
  const rounded = (abs - whole * revenue) * 2 >= revenue ? whole + 1 : whole;
  return toBps(negative ? -rounded : rounded);
}

/** The signature as a first-class type, so a fake or a decorated variant is checkable against it. */
export type ComputeOrderProfit = (input: Readonly<OrderProfitInput>) => OrderProfitResult;
