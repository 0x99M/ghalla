import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MAX_MINOR, toBps, toMinor } from '@ghalla/contracts';
import type {
  Bps,
  CanonicalOrder,
  CanonicalOrderItem,
  CanonicalShipment,
  CostHistoryId,
  Minor,
  OrderId,
  OrderItemId,
  PaymentBreakdown,
} from '@ghalla/contracts';
import { computeOrderProfit, isRankableForLossMaker } from '../src/compute-order-profit.js';
import type { Diagnostic } from '../src/diagnostics.js';
import type { OrderProfitInput } from '../src/input.js';
import type { ProfitRecognition } from '../src/result.js';
import type { ResolvedCost } from '../src/cost.js';
import type { CodFeeRule, FeeFormula, GatewayFeeRule } from '../src/fee-rules.js';
import {
  MoneyKernelError,
  addMinor,
  allocateMinor,
  assertInRange,
  clampMinor,
  divRoundHalfAway,
  mulBps,
} from '../src/money.js';
import { applyFeeFormula, basisOfFeeSource } from '../src/engine/fee.js';
import { computeCogs } from '../src/engine/cogs.js';
import { computeCodCost } from '../src/engine/cod.js';
import { computeGatewayFees } from '../src/engine/gateway.js';
import { computeLineRevenue, computeRevenue } from '../src/engine/revenue.js';
import { deriveConfidence } from '../src/engine/confidence.js';
import type { TermBases } from '../src/engine/confidence.js';
import type { CostIndex } from '../src/engine/normalize.js';
import { productKeyOf } from '../src/engine/normalize.js';

const m = (n: number): Minor => toMinor(n);
const bp = (n: number): Bps => toBps(n);
const codes = (diagnostics: readonly Diagnostic[]): readonly string[] => diagnostics.map((d) => d.code);

// ------------------------------------------------------------------ fees ----

const FORMULA: FeeFormula = {
  percentBps: bp(275),
  fixedMinor: m(100),
  minFeeMinor: null,
  maxFeeMinor: null,
  feeVatBps: bp(1_500),
  ratesIncludeVat: false,
  source: 'merchant_entered',
};

const formula = (over: Partial<FeeFormula>): FeeFormula => ({ ...FORMULA, ...over });

describe('applyFeeFormula', () => {
  it('charges VAT on the fee itself, which a bare percentage silently omits', () => {
    // SAR 575.00 at 2.75% + SAR 1.00 = SAR 16.81, and Saudi law taxes the
    // commission. Omitting the VAT understates gateway cost by 15% on every card
    // order, uniformly, in the direction that flatters margin.
    expect(applyFeeFormula(m(57_500), formula({}), true)).toEqual({
      exVatMinor: 1_681,
      vatMinor: 252,
      costMinor: 1_681,
    });
  });

  it('reads an inclusive quote as already carrying its VAT, rather than adding it twice', () => {
    const inclusive = applyFeeFormula(m(57_500), formula({ ratesIncludeVat: true }), true);
    // The same SAR 16.81 the processor quoted, split rather than grossed up.
    expect(inclusive.exVatMinor + inclusive.vatMinor).toBe(1_681);
    expect(inclusive).toEqual({ exVatMinor: 1_462, vatMinor: 219, costMinor: 1_462 });
    // Reading a 2.75% inclusive quote as exclusive costs the merchant SAR 2.19 on
    // this one order; there is no signal but this flag to tell the two apart.
    expect(applyFeeFormula(m(57_500), formula({}), true).exVatMinor - inclusive.exVatMinor).toBe(219);
  });

  it('makes an unregistered merchant carry the fee VAT as a real cost', () => {
    // Below the registration threshold there is no input-VAT reclaim, so the
    // 15% is money gone rather than money passing through.
    expect(applyFeeFormula(m(57_500), formula({}), false).costMinor).toBe(1_933);
    expect(applyFeeFormula(m(57_500), formula({}), true).costMinor).toBe(1_681);
  });

  it('caps the fee where the processor caps it, instead of overcharging a large basket', () => {
    // SAR 3,000 at 2.75% would be SAR 83.50; the contract caps the transaction
    // at SAR 20. Uncapped, every furniture and electronics order is wrong, and
    // it is the first one a merchant checks against their statement.
    expect(applyFeeFormula(m(300_000), formula({ maxFeeMinor: m(2_000) }), true).exVatMinor).toBe(2_000);
  });

  it('lifts a small basket to the floor the courier quoted', () => {
    // SAR 100.00 at 2% is SAR 2.00, under the courier's SAR 8.00 minimum.
    expect(applyFeeFormula(m(10_000), formula({ percentBps: bp(200), fixedMinor: m(0), minFeeMinor: m(800) }), true))
      .toEqual({ exVatMinor: 800, vatMinor: 120, costMinor: 800 });
  });

  it('leaves a fee between the floor and the cap exactly where the formula put it', () => {
    expect(
      applyFeeFormula(m(57_500), formula({ minFeeMinor: m(100), maxFeeMinor: m(20_000) }), true).exVatMinor,
    ).toBe(1_681);
  });
});

describe('basisOfFeeSource', () => {
  it('calls only a processor statement settled — a merchant’s own rate card is still an estimate', () => {
    // The product's honesty budget: estimated means we applied your rate card to
    // this order, not that we saw what the order was actually charged.
    expect(basisOfFeeSource('gateway_statement')).toBe('actual');
    expect(basisOfFeeSource('merchant_entered')).toBe('estimated');
    expect(basisOfFeeSource('default_table')).toBe('estimated');
  });
});

// ------------------------------------------------------------------ cogs ----

const cost = (over: Partial<ResolvedCost>): ResolvedCost => ({
  platformProductId: 'P1',
  platformVariantId: null,
  sku: 'SKU-1',
  unitCostMinor: m(8_000),
  source: 'merchant_manual',
  costHistoryId: 'ch_1' as CostHistoryId,
  ...over,
});

function indexOf(...costs: readonly ResolvedCost[]): CostIndex {
  const byProductKey = new Map<string, ResolvedCost>();
  const bySku = new Map<string, ResolvedCost>();
  for (const row of costs) {
    byProductKey.set(productKeyOf(row.platformProductId, row.platformVariantId), row);
    if (row.sku !== null && row.sku !== '') bySku.set(row.sku, row);
  }
  return { byProductKey, bySku };
}

const item = (over: Partial<CanonicalOrderItem>): CanonicalOrderItem =>
  ({
    id: 'demo:1:1001#L1' as OrderItemId,
    orderId: 'demo:1:1001' as OrderId,
    platformLineId: 'L1',
    platformProductId: 'P1',
    platformVariantId: null,
    sku: 'SKU-1',
    productName: 'منتج',
    quantity: 1,
    unitPriceExVatMinor: m(20_000),
    grossLineExVatMinor: m(20_000),
    lineDiscountExVatMinor: m(0),
    lineTotalExVatMinor: m(20_000),
    ...over,
  }) as CanonicalOrderItem;

describe('computeCogs', () => {
  it('resolves a line by product and variant, and multiplies by the quantity', () => {
    const result = computeCogs(
      [item({ platformVariantId: 'V2', quantity: 3 })],
      indexOf(cost({ platformVariantId: 'V2', unitCostMinor: m(8_000) })),
    );
    expect(result.value.cogsMinor).toBe(24_000);
    expect(result.value.lines[0]).toMatchObject({ unitCostMinor: 8_000, covered: true, costHistoryId: 'ch_1' });
    expect(result.diagnostics).toEqual([]);
  });

  it('falls back to the SKU where the platform puts no variant identity on the line', () => {
    // Some platforms make the SKU the de facto variant key. Without the fallback
    // every line on those stores reports as uncosted.
    const result = computeCogs(
      [item({ platformProductId: 'P-UNSEEN', sku: 'SKU-1' })],
      indexOf(cost({ platformProductId: 'P1', sku: 'SKU-1', unitCostMinor: m(3_500) })),
    );
    expect(result.value.cogsMinor).toBe(3_500);
    expect(result.value.anyMissing).toBe(false);
  });

  it('prefers the product key over the SKU, because a SKU is merchant-entered free text', () => {
    // Two rows that disagree. Keying on the SKU first would merge unrelated
    // products the moment a merchant reuses a code.
    const index: CostIndex = {
      byProductKey: new Map([['P1|', cost({ unitCostMinor: m(8_000), costHistoryId: 'ch_key' as CostHistoryId })]]),
      bySku: new Map([['SKU-1', cost({ unitCostMinor: m(3_500), costHistoryId: 'ch_sku' as CostHistoryId })]]),
    };
    expect(computeCogs([item({})], index).value.lines[0]).toMatchObject({
      unitCostMinor: 8_000,
      costHistoryId: 'ch_key',
    });
  });

  it('does not resolve a line whose SKU is blank', () => {
    // A blank SKU is the platform saying nothing, not a key. Matching on it
    // would attach one product's cost to every uncoded line in the catalogue.
    for (const sku of [null, '']) {
      const result = computeCogs([item({ platformProductId: 'P-UNSEEN', sku })], indexOf(cost({})));
      expect(result.value.anyMissing).toBe(true);
      expect(codes(result.diagnostics)).toEqual(['COST_MISSING']);
    }
  });

  it('contributes ZERO for an unpriced line and says so loudly', () => {
    // Zero cost reports the line as the most profitable product in the
    // catalogue, which is why the term becomes `missing` rather than
    // `estimated`: the error is directional, and it flatters.
    const result = computeCogs([item({ platformProductId: 'P-UNSEEN', sku: 'SKU-UNSEEN' })], indexOf(cost({})));
    expect(result.value.cogsMinor).toBe(0);
    expect(result.value.lines[0]).toMatchObject({
      unitCostMinor: 0,
      cogsMinor: 0,
      source: 'none',
      costHistoryId: null,
      covered: false,
    });
    expect(result.diagnostics[0]?.subject).toEqual({ kind: 'line', orderItemId: 'demo:1:1001#L1' });
  });

  it('counts a category default in the number but keeps it out of coverage', () => {
    // The contrast that matters: an estimate still contributes its amount, so
    // the margin is centred; a miss contributes nothing at all.
    const result = computeCogs(
      [item({ quantity: 2 })],
      indexOf(cost({ source: 'category_default', unitCostMinor: m(4_000) })),
    );
    expect(result.value.cogsMinor).toBe(8_000);
    expect(result.value.anyEstimated).toBe(true);
    expect(result.value.anyMissing).toBe(false);
    expect(result.value.lines[0]?.covered).toBe(false);
    expect(codes(result.diagnostics)).toEqual(['COST_ESTIMATED']);
  });

  it('sums the lines it could price and flags only the one it could not', () => {
    const result = computeCogs(
      [
        item({ id: 'demo:1:1001#L1' as OrderItemId, platformProductId: 'P1' }),
        item({ id: 'demo:1:1001#L2' as OrderItemId, platformProductId: 'P2', sku: 'SKU-2' }),
      ],
      indexOf(cost({ platformProductId: 'P1', unitCostMinor: m(8_000) })),
    );
    expect(result.value.cogsMinor).toBe(8_000);
    expect(result.value.anyMissing).toBe(true);
    expect(result.diagnostics[0]?.subject).toEqual({ kind: 'line', orderItemId: 'demo:1:1001#L2' });
  });
});

// --------------------------------------------------------------- revenue ----

const revenueOrder = (over: Partial<CanonicalOrder>): CanonicalOrder =>
  ({
    subtotalExVatMinor: m(30_000),
    vatAmountMinor: m(4_725),
    shippingChargedExVatMinor: m(1_000),
    codFeeChargedExVatMinor: m(500),
    totalIncVatMinor: m(36_225),
    discounts: [],
    ...over,
  }) as CanonicalOrder;

const TWO_LINES: readonly CanonicalOrderItem[] = [
  item({ id: 'demo:1:1001#L1' as OrderItemId, platformLineId: 'L1', lineTotalExVatMinor: m(20_000) }),
  item({ id: 'demo:1:1001#L2' as OrderItemId, platformLineId: 'L2', lineTotalExVatMinor: m(10_000) }),
];

const RECOGNIZED: ProfitRecognition = { kind: 'recognized' };

describe('computeLineRevenue', () => {
  it('splits an order-level coupon across lines by revenue share', () => {
    const lines = computeLineRevenue(TWO_LINES, m(3_000));
    expect(lines.map((l) => l.allocatedOrderDiscountExVatMinor)).toEqual([2_000, 1_000]);
    expect(lines.map((l) => l.netExVatMinor)).toEqual([18_000, 9_000]);
  });

  it('returns nothing for an order with no lines, where the allocator would throw', () => {
    // An order whose items failed to ingest still has to produce a result: the
    // kernel refuses to spread a non-zero total across zero buckets, and this is
    // the guard that keeps that refusal out of the engine's totality promise.
    expect(computeLineRevenue([], m(3_000))).toEqual([]);
    expect(() => allocateMinor(m(3_000), [])).toThrow(MoneyKernelError);
  });
});

describe('computeRevenue', () => {
  it('takes a shipping coupon off revenue without touching the item lines', () => {
    const order = revenueOrder({
      totalIncVatMinor: m(35_925),
      discounts: [{ code: 'FREESHIP', target: 'shipping', reflectedInComponent: false, amountExVatMinor: m(300) }],
    });
    const result = computeRevenue(order, TWO_LINES, RECOGNIZED);
    expect(result.value.revenueExVatMinor).toBe(31_200);
    // The charge the customer was shown stays reported; the coupon is carried
    // beside it, because the per-line allocator needs the net of the two and a
    // second reading of `order.discounts` is how the two came to disagree.
    expect(result.value.shippingRevenueExVatMinor).toBe(1_000);
    expect(result.value.shippingDiscountExVatMinor).toBe(300);
    expect(result.value.lines.map((l) => l.allocatedOrderDiscountExVatMinor)).toEqual([0, 0]);
    expect(result.value.reconciles).toBe(true);
  });

  it('takes a cash-on-delivery fee waiver off revenue the same way', () => {
    const order = revenueOrder({
      totalIncVatMinor: m(36_025),
      discounts: [{ code: null, target: 'cod_fee', reflectedInComponent: false, amountExVatMinor: m(200) }],
    });
    const result = computeRevenue(order, TWO_LINES, RECOGNIZED);
    expect(result.value.codFeeRevenueExVatMinor).toBe(500);
    expect(result.value.codFeeDiscountExVatMinor).toBe(200);
    expect(result.value.revenueExVatMinor).toBe(31_300);
  });

  it('allocates an items coupon across the lines it discounted', () => {
    const order = revenueOrder({
      totalIncVatMinor: m(33_225),
      discounts: [{ code: 'SAVE30', target: 'items', reflectedInComponent: false, amountExVatMinor: m(3_000) }],
    });
    const result = computeRevenue(order, TWO_LINES, RECOGNIZED);
    expect(result.value.revenueExVatMinor).toBe(28_500);
    expect(result.value.lines.map((l) => l.netExVatMinor)).toEqual([18_000, 9_000]);
  });

  it('IGNORES a coupon the platform already deducted from the line totals', () => {
    // The one field that makes double counting unrepresentable. Subtracting a
    // reflected discount again would deflate this order by SAR 30 with nothing
    // in the data to say which reading was meant.
    const order = revenueOrder({
      discounts: [{ code: 'SAVE30', target: 'items', reflectedInComponent: true, amountExVatMinor: m(3_000) }],
    });
    const result = computeRevenue(order, TWO_LINES, RECOGNIZED);
    expect(result.value.orderDiscountExVatMinor).toBe(0);
    expect(result.value.revenueExVatMinor).toBe(31_500);
    expect(result.value.lines.map((l) => l.netExVatMinor)).toEqual([20_000, 10_000]);
    expect(result.value.reconciles).toBe(true);
  });

  it('zeroes every revenue term on a cost-only order, and still names each line', () => {
    // A refused cash-on-delivery parcel: the costs were real and nothing was
    // collected. The lines survive so the costs still have somewhere to land.
    const result = computeRevenue(revenueOrder({}), TWO_LINES, { kind: 'cost_only', reason: 'rto_uncollected' });
    expect(result.value.revenueExVatMinor).toBe(0);
    expect(result.value.itemsRevenueExVatMinor).toBe(0);
    expect(result.value.vatCollectedMinor).toBe(0);
    expect(result.value.lines.map((l) => l.grossExVatMinor)).toEqual([0, 0]);
    expect(codes(result.diagnostics)).toContain('RECOGNITION_COST_ONLY');
  });

  it('says the order was excluded rather than that its costs were real', () => {
    // A test order and a refused parcel both report zero revenue; only one of
    // them cost the merchant anything, and the diagnostic is what separates them.
    const result = computeRevenue(revenueOrder({}), TWO_LINES, { kind: 'excluded', reason: 'test_order' });
    expect(codes(result.diagnostics)).toContain('ORDER_EXCLUDED');
    expect(codes(result.diagnostics)).not.toContain('RECOGNITION_COST_ONLY');
  });

  it('flags an order whose items failed to ingest instead of reporting the revenue as vanished', () => {
    const result = computeRevenue(revenueOrder({}), [], RECOGNIZED);
    expect(result.value.reconciles).toBe(false);
    expect(codes(result.diagnostics)).toEqual(
      expect.arrayContaining(['TOTALS_DO_NOT_RECONCILE', 'ORDER_HAS_NO_ITEMS']),
    );
  });
});

// --------------------------------------------------------------- gateway ----

const leg = (over: Partial<PaymentBreakdown>): PaymentBreakdown => ({
  instrument: 'card',
  scheme: 'visa',
  wallet: null,
  provider: null,
  rawMethodLabel: 'visa',
  state: 'captured',
  amountGrossMinor: m(10_000),
  transactionRef: null,
  ...over,
});

const orderWith = (payments: readonly PaymentBreakdown[], over: Partial<CanonicalOrder> = {}): CanonicalOrder =>
  ({ paymentState: 'paid', totalIncVatMinor: m(10_000), payments, ...over }) as CanonicalOrder;

const paidWith = (payments: readonly PaymentBreakdown[], total = 10_000): CanonicalOrder =>
  orderWith(payments, { totalIncVatMinor: m(total) });

const gatewayRule = (over: Partial<GatewayFeeRule>): GatewayFeeRule => ({
  instrument: null,
  scheme: null,
  provider: null,
  percentBps: bp(275),
  fixedMinor: m(0),
  minFeeMinor: null,
  maxFeeMinor: null,
  feeVatBps: bp(1_500),
  ratesIncludeVat: false,
  source: 'merchant_entered',
  ...over,
});

describe('computeGatewayFees', () => {
  it('prices a captured card leg from the rule for its own network', () => {
    const result = computeGatewayFees(
      paidWith([leg({ scheme: 'mada' })]),
      [gatewayRule({ instrument: 'card', scheme: 'mada', percentBps: bp(100) }), gatewayRule({ instrument: 'card', scheme: 'visa', percentBps: bp(275) })],
      true,
    );
    expect(result.value).toEqual({ exVatMinor: 100, vatMinor: 15, costMinor: 100, basis: 'estimated' });
    expect(result.diagnostics).toEqual([]);
  });

  it('assumes the MORE EXPENSIVE network when the platform will not say which was behind the wallet', () => {
    // Understating a merchant's profit and being corrected is survivable;
    // overstating it and being caught is not. The two candidates differ by 2.75x
    // on this leg, so the choice is not cosmetic.
    for (const scheme of [null, 'unknown'] as const) {
      const result = computeGatewayFees(
        paidWith([leg({ scheme, wallet: 'apple_pay', rawMethodLabel: 'apple_pay' })]),
        [
          gatewayRule({ instrument: 'card', scheme: 'mada', percentBps: bp(100) }),
          gatewayRule({ instrument: 'card', scheme: 'visa', percentBps: bp(275) }),
        ],
        true,
      );
      expect(result.value.exVatMinor).toBe(275);
      expect(result.value.basis).toBe('estimated');
      expect(codes(result.diagnostics)).toEqual(['CARD_SCHEME_UNKNOWN']);
    }
  });

  it('takes the DEAREST candidate, which is not the highest percentage once a cap bites', () => {
    // SAR 3,000 through a 2.75% rate capped at SAR 20 costs less than through an
    // uncapped 1.5% one. Picking by headline rate would understate this leg by
    // SAR 25 — and the merchant only has a wallet label to argue with.
    const capped = gatewayRule({ instrument: 'card', scheme: 'visa', percentBps: bp(275), maxFeeMinor: m(2_000) });
    const uncapped = gatewayRule({ instrument: 'card', scheme: 'mada', percentBps: bp(150) });
    const order = paidWith([leg({ scheme: 'unknown', wallet: 'apple_pay', amountGrossMinor: m(300_000) })], 300_000);
    expect(computeGatewayFees(order, [capped, uncapped], true).value.exVatMinor).toBe(4_500);
    // And the same whichever way round the rate card lists them.
    expect(computeGatewayFees(order, [uncapped, capped], true).value.exVatMinor).toBe(4_500);
  });

  it('never prices a leg with a rate negotiated with a processor the merchant did not use', () => {
    // Rates are per-processor and negotiated. Letting another processor's row
    // into the comparison makes the most expensive rule in the table the answer
    // for every wallet order on the store.
    const result = computeGatewayFees(
      paidWith([leg({ scheme: 'unknown', provider: 'payfort' })]),
      [
        gatewayRule({ instrument: 'card', scheme: 'visa', provider: 'payfort', percentBps: bp(275) }),
        gatewayRule({ instrument: 'card', scheme: 'mada', provider: 'hyperpay', percentBps: bp(5_000) }),
      ],
      true,
    );
    expect(result.value.exVatMinor).toBe(275);
  });

  it('lets the most specific rule win, and degrades a tier at a time when it is absent', () => {
    const rules = [
      gatewayRule({ instrument: 'card', percentBps: bp(900) }),
      gatewayRule({ instrument: 'card', scheme: 'visa', percentBps: bp(500) }),
      gatewayRule({ instrument: 'card', scheme: 'visa', provider: 'payfort', percentBps: bp(275) }),
    ];
    // instrument + scheme + provider beats instrument + scheme beats instrument.
    expect(computeGatewayFees(paidWith([leg({ provider: 'payfort' })]), rules, true).value.exVatMinor).toBe(275);
    expect(computeGatewayFees(paidWith([leg({ provider: 'other_psp' })]), rules, true).value.exVatMinor).toBe(500);
    // A network the merchant has no row for falls back to their card rate rather
    // than reporting the fee as unknowable.
    expect(computeGatewayFees(paidWith([leg({ scheme: 'amex' })]), rules, true).value.exVatMinor).toBe(900);
    // And the answer is the same whichever order the caller's query returned the
    // rows in: a 3.3x swing in the fee decided by row order is not a fee.
    const reversed = [...rules].reverse();
    expect(computeGatewayFees(paidWith([leg({ provider: 'payfort' })]), reversed, true).value.exVatMinor).toBe(275);
    expect(computeGatewayFees(paidWith([leg({ scheme: 'amex' })]), reversed, true).value.exVatMinor).toBe(900);
  });

  it('reports a leg it cannot price as MISSING rather than as free', () => {
    // A zero fee at confidence `exact` is the shape that loses a merchant's
    // trust: the number looks settled and it is a guess at zero.
    const result = computeGatewayFees(
      paidWith([leg({ instrument: 'bnpl', scheme: null, rawMethodLabel: 'tabby' })]),
      [gatewayRule({ instrument: 'card', scheme: 'visa' })],
      true,
    );
    expect(result.value).toEqual({ exVatMinor: 0, vatMinor: 0, costMinor: 0, basis: 'missing' });
    expect(result.diagnostics).toEqual([
      { code: 'FEE_RULE_MISSING', severity: 'warning', subject: { kind: 'payment', index: 0 } },
    ]);
  });

  it('names an instrument the adapter could not classify, for both ways of failing to classify it', () => {
    // `unknown` and `other` are different admissions — the platform said nothing,
    // or it said something we have no rail for — and both leave the fee a guess
    // even when a catch-all rate prices the leg.
    const result = computeGatewayFees(
      paidWith(
        [
          leg({ instrument: 'unknown', scheme: null, rawMethodLabel: 'store_credit' }),
          leg({ instrument: 'other', scheme: null, rawMethodLabel: 'tamara_later' }),
        ],
        20_000,
      ),
      [gatewayRule({ percentBps: bp(100) })],
      true,
    );
    expect(codes(result.diagnostics)).toEqual(['UNKNOWN_PAYMENT_INSTRUMENT', 'UNKNOWN_PAYMENT_INSTRUMENT']);
    expect(result.diagnostics.map((d) => d.subject)).toEqual([
      { kind: 'payment', index: 0 },
      { kind: 'payment', index: 1 },
    ]);
    expect(result.value.exVatMinor).toBe(200);
  });

  it('flags legs that do not add up to a paid order’s total, because the shortfall is unpriced', () => {
    // Fees are proportional to the legs an adapter actually mapped, so
    // under-mapping always flatters margin. The leg that was mapped is still
    // priced — the term is degraded, not discarded.
    const result = computeGatewayFees(
      paidWith([leg({ amountGrossMinor: m(20_000) })], 36_225),
      [gatewayRule({ instrument: 'card', scheme: 'visa', percentBps: bp(275) })],
      true,
    );
    expect(result.value.exVatMinor).toBe(550);
    expect(result.value.basis).toBe('missing');
    expect(codes(result.diagnostics)).toContain('PAYMENT_LEGS_UNDER_TOTAL');
  });

  it('calls a paid order with no captured leg at all MISSING, not inapplicable', () => {
    // The partially mapped case was warned and the totally unmapped one was
    // silent, which is backwards: a fee we failed to see is not a fee that does
    // not exist.
    const unmapped = computeGatewayFees(
      paidWith([leg({ state: 'authorized' })], 36_225),
      [gatewayRule({ instrument: 'card', scheme: 'visa' })],
      true,
    );
    expect(unmapped.value).toEqual({ exVatMinor: 0, vatMinor: 0, costMinor: 0, basis: 'missing' });
    expect(codes(unmapped.diagnostics)).toEqual(['PAYMENT_LEGS_UNDER_TOTAL']);

    // An order the platform does not call paid genuinely has no gateway fee to
    // find, and must not be flagged for it.
    const unpaid = computeGatewayFees(
      orderWith([leg({ state: 'authorized' })], { paymentState: 'unpaid', totalIncVatMinor: m(36_225) }),
      [gatewayRule({})],
      true,
    );
    expect(unpaid.value.basis).toBe('not_applicable');
    expect(unpaid.diagnostics).toEqual([]);
  });

  it('accrues nothing on a cash-on-delivery or fully discounted leg', () => {
    // There is no gateway behind either: cash was handed to a courier, and a
    // 100%-discounted order was never charged. A catch-all rate must not invent
    // a processor fee for them.
    const result = computeGatewayFees(
      paidWith(
        [
          leg({ instrument: 'cod', scheme: null, rawMethodLabel: 'cash_on_delivery', amountGrossMinor: m(6_000) }),
          leg({ instrument: 'free', scheme: null, rawMethodLabel: 'free', amountGrossMinor: m(4_000) }),
        ],
        10_000,
      ),
      [gatewayRule({ percentBps: bp(275) })],
      true,
    );
    expect(result.value).toEqual({ exVatMinor: 0, vatMinor: 0, costMinor: 0, basis: 'not_applicable' });
    expect(result.diagnostics).toEqual([]);
  });

  it('prices only the legs that went through a processor, on an order that mixes rails', () => {
    // The split-tender shape: half on a card, the remainder in cash at the door.
    // Charging the processor's percentage on the cash would invent a fee nobody
    // was billed, and it grows with the part of the order the gateway never saw.
    const result = computeGatewayFees(
      paidWith(
        [
          leg({ amountGrossMinor: m(20_000) }),
          leg({ instrument: 'cod', scheme: null, rawMethodLabel: 'cash_on_delivery', amountGrossMinor: m(16_225) }),
        ],
        36_225,
      ),
      [gatewayRule({ instrument: 'card', scheme: 'visa', percentBps: bp(275) })],
      true,
    );
    expect(result.value.exVatMinor).toBe(550);
    expect(result.value.basis).toBe('estimated');
    expect(result.diagnostics).toEqual([]);
  });

  it('marks a published default rate as such, so the dashboard can ask the merchant to confirm it', () => {
    const result = computeGatewayFees(
      paidWith([leg({})]),
      [gatewayRule({ instrument: 'card', scheme: 'visa', source: 'default_table' })],
      true,
    );
    expect(codes(result.diagnostics)).toEqual(['FEE_RULE_DEFAULT_USED']);
    expect(result.value.basis).toBe('estimated');
  });

  it('is `actual` only when every leg was priced from a settled statement', () => {
    const settled = [gatewayRule({ instrument: 'card', scheme: 'visa', source: 'gateway_statement' })];
    expect(computeGatewayFees(paidWith([leg({})]), settled, true).value.basis).toBe('actual');

    // One estimated leg is enough to degrade the order's whole term.
    const mixed = computeGatewayFees(
      paidWith([leg({}), leg({ scheme: 'mada' })], 20_000),
      [...settled, gatewayRule({ instrument: 'card', scheme: 'mada', source: 'merchant_entered' })],
      true,
    );
    expect(mixed.value.basis).toBe('estimated');
  });

  it('prices an unknown scheme from a blended catch-all rate when that is the whole rate card', () => {
    // A merchant who typed one blended rate at onboarding has no card table for
    // a catch-all to outbid, and the rate does not depend on the scheme — so the
    // fee here is knowable. Reporting it as missing zeroes the gateway cost on
    // every wallet order and pushes the order out of loss-maker ranking.
    // FAILING: schemeCandidates requires an exact instrument match, so the
    // instrument-agnostic row is never a candidate.
    const result = computeGatewayFees(
      paidWith([leg({ scheme: 'unknown', wallet: 'apple_pay' })]),
      [gatewayRule({ percentBps: bp(275) })],
      true,
    );
    expect(result.value.exVatMinor).toBe(275);
    expect(codes(result.diagnostics)).not.toContain('FEE_RULE_MISSING');
  });
});

// ------------------------------------------------------------------- cod ----

const parcel = (over: Partial<CanonicalShipment>): CanonicalShipment =>
  ({ direction: 'outbound', status: 'delivered', carrier: 'aramex', ...over }) as CanonicalShipment;

const codRule = (over: Partial<CodFeeRule>): CodFeeRule => ({
  carrier: null,
  percentBps: bp(200),
  fixedMinor: m(0),
  minFeeMinor: null,
  maxFeeMinor: null,
  feeVatBps: bp(1_500),
  ratesIncludeVat: false,
  source: 'merchant_entered',
  ...over,
});

const codLeg = (amount: number, over: Partial<PaymentBreakdown> = {}): PaymentBreakdown =>
  leg({ instrument: 'cod', scheme: null, rawMethodLabel: 'cash_on_delivery', amountGrossMinor: m(amount), ...over });

describe('computeCodCost', () => {
  it('charges the courier’s cash-handling fee against the cash it actually carried', () => {
    // SAR 62.25 at 2% is SAR 1.245, plus the SAR 8.00 the courier charges per
    // collection.
    const result = computeCodCost(
      paidWith([codLeg(6_225)]),
      [parcel({})],
      [codRule({ fixedMinor: m(800) })],
      true,
    );
    expect(result.value).toEqual({ exVatMinor: 925, vatMinor: 139, costMinor: 925, basis: 'estimated' });
  });

  it('prefers the rule written for this courier over the store’s catch-all', () => {
    // The rate differs between two couriers a single store uses on the same day,
    // which is the reason this is keyed by carrier at all.
    const result = computeCodCost(
      paidWith([codLeg(10_000)]),
      [parcel({ carrier: 'smsa' })],
      [codRule({ percentBps: bp(500) }), codRule({ carrier: 'smsa', percentBps: bp(200) })],
      true,
    );
    expect(result.value.exVatMinor).toBe(200);
  });

  it('splits the collected cash between couriers and prices each share under its own card', () => {
    // Split fulfilment. Nothing reports which parcel the cash came with, so an
    // even split is the honest default — but taking "whichever shipment sorted
    // first" would decide a 2x difference in the fee by a shipment id.
    const result = computeCodCost(
      paidWith([codLeg(10_001)]),
      [parcel({ carrier: 'aramex' }), parcel({ carrier: 'smsa' })],
      [codRule({ carrier: 'aramex', percentBps: bp(200) }), codRule({ carrier: 'smsa', percentBps: bp(100) })],
      true,
    );
    // SAR 50.01 at 2% plus SAR 50.00 at 1%, not SAR 100.01 at either rate.
    expect(result.value.exVatMinor).toBe(150);
  });

  it('ignores a cancelled label, which never carried any cash', () => {
    // A label printed and voided is not a courier that handled money. Counting
    // it halves the fee attributed to the courier that did.
    const result = computeCodCost(
      paidWith([codLeg(10_000)]),
      [
        parcel({ carrier: 'aramex' }),
        parcel({ carrier: 'smsa', status: 'cancelled' }),
        parcel({ carrier: 'naqel', direction: 'return', status: 'returned_to_origin' }),
      ],
      [
        codRule({ carrier: 'aramex', percentBps: bp(200) }),
        codRule({ carrier: 'smsa', percentBps: bp(1_000) }),
        codRule({ carrier: 'naqel', percentBps: bp(1_000) }),
      ],
      true,
    );
    expect(result.value.exVatMinor).toBe(200);
  });

  it('accrues nothing on a cash-on-delivery leg that was never captured', () => {
    // The refused parcel: nobody was handed cash to handle, so the loss is the
    // two shipping legs and nothing else.
    for (const state of ['pending', 'authorized', 'failed'] as const) {
      const result = computeCodCost(paidWith([codLeg(10_000, { state })]), [parcel({})], [codRule({})], true);
      expect(result.value).toEqual({ exVatMinor: 0, vatMinor: 0, costMinor: 0, basis: 'not_applicable' });
      expect(result.diagnostics).toEqual([]);
    }
  });

  it('still charges the store’s catch-all rate when no parcel has shipped yet', () => {
    // Cash collected with no live outbound leg on record. There is no carrier to
    // key on, and dropping the fee would report the order as cheaper than it is.
    const result = computeCodCost(
      paidWith([codLeg(10_000)]),
      [parcel({ status: 'cancelled' })],
      [codRule({ percentBps: bp(200) }), codRule({ carrier: 'aramex', percentBps: bp(1_000) })],
      true,
    );
    expect(result.value.exVatMinor).toBe(200);
  });

  it('reports a courier it has no rate for as MISSING rather than as free', () => {
    const result = computeCodCost(
      paidWith([codLeg(10_000)]),
      [parcel({ carrier: 'aramex' })],
      [codRule({ carrier: 'smsa', percentBps: bp(200) })],
      true,
    );
    expect(result.value).toEqual({ exVatMinor: 0, vatMinor: 0, costMinor: 0, basis: 'missing' });
    expect(result.diagnostics).toEqual([
      { code: 'COD_FEE_RULE_MISSING', severity: 'warning', subject: { kind: 'payment', index: 0 } },
    ]);
  });

  it('degrades the whole term when one courier of two has no rate', () => {
    // Half a fee is not half-trustworthy: the order's cod term is a bound, and
    // the level it feeds is what keeps it out of loss-maker ranking.
    const result = computeCodCost(
      paidWith([codLeg(10_000)]),
      [parcel({ carrier: 'aramex' }), parcel({ carrier: 'smsa' })],
      [codRule({ carrier: 'aramex', percentBps: bp(200) })],
      true,
    );
    expect(result.value.exVatMinor).toBe(100);
    expect(result.value.basis).toBe('missing');
    expect(codes(result.diagnostics)).toEqual(['COD_FEE_RULE_MISSING']);
  });

  it('marks a published default rate as such, and a settled one as actual', () => {
    const defaulted = computeCodCost(
      paidWith([codLeg(10_000)]),
      [parcel({})],
      [codRule({ source: 'default_table' })],
      true,
    );
    expect(codes(defaulted.diagnostics)).toEqual(['FEE_RULE_DEFAULT_USED']);
    expect(defaulted.value.basis).toBe('estimated');

    const settled = computeCodCost(
      paidWith([codLeg(10_000)]),
      [parcel({})],
      [codRule({ source: 'gateway_statement' })],
      true,
    );
    expect(settled.value.basis).toBe('actual');
    expect(settled.diagnostics).toEqual([]);
  });

  it('makes an unregistered merchant carry the VAT on the handling fee', () => {
    const registered = computeCodCost(paidWith([codLeg(10_000)]), [parcel({})], [codRule({})], true);
    const unregistered = computeCodCost(paidWith([codLeg(10_000)]), [parcel({})], [codRule({})], false);
    expect(registered.value.costMinor).toBe(200);
    expect(unregistered.value.costMinor).toBe(230);
  });
});

// ------------------------------------------------------------ confidence ----

const BASES: TermBases = {
  reconciles: true,
  cogs: 'actual',
  outboundShipping: 'actual',
  returnShipping: 'not_applicable',
  gatewayFee: 'actual',
  codCost: 'not_applicable',
  reversal: 'not_applicable',
};

const bases = (over: Partial<TermBases>): TermBases => ({ ...BASES, ...over });
const warning = (code: Diagnostic['code']): Diagnostic => ({ code, severity: 'warning', subject: { kind: 'order' } });

describe('deriveConfidence', () => {
  it('is exact only when every term is a settled figure', () => {
    expect(deriveConfidence(bases({}), []).level).toBe('exact');
    expect(deriveConfidence(bases({}), []).revenue).toBe('reported');
    // A reversal the platform itself reported line by line is settled too.
    expect(deriveConfidence(bases({ reversal: 'reported' }), []).level).toBe('exact');
  });

  it('drops to estimated when a term came from a rate card rather than a charge', () => {
    expect(deriveConfidence(bases({ gatewayFee: 'estimated' }), []).level).toBe('estimated');
    expect(deriveConfidence(bases({ cogs: 'estimated' }), []).level).toBe('estimated');
  });

  it('drops to incomplete when ANY term is missing, however settled the rest are', () => {
    // The hard gate. A margin computed with a missing input is a bound, and
    // loss-maker ranking must not see it.
    for (const term of ['cogs', 'outboundShipping', 'returnShipping', 'gatewayFee', 'codCost'] as const) {
      expect(deriveConfidence(bases({ [term]: 'missing' }), []).level).toBe('incomplete');
    }
  });

  it('drops to incomplete when the order’s own totals do not reconcile', () => {
    // Revenue is then the adapter's arithmetic rather than the merchant's, and
    // every other term is measured against it.
    const result = deriveConfidence(bases({ reconciles: false }), []);
    expect(result.revenue).toBe('unreconciled');
    expect(result.level).toBe('incomplete');
  });

  it('treats an order with no items as revenue it cannot vouch for', () => {
    const result = deriveConfidence(bases({}), [warning('ORDER_HAS_NO_ITEMS')]);
    expect(result.revenue).toBe('unreconciled');
    expect(result.level).toBe('incomplete');
  });

  it('makes an unconfirmed restock degrade the COGS credit it is based on', () => {
    // The goods may come back damaged or not at all, so the credit is a guess
    // however well-founded, and an order carrying one can never be exact.
    expect(deriveConfidence(bases({ cogs: 'actual' }), [warning('RESTOCK_UNKNOWN')]).cogs).toBe('estimated');
    expect(deriveConfidence(bases({ cogs: 'not_applicable' }), [warning('RESTOCK_UNKNOWN')]).cogs).toBe('estimated');
    expect(deriveConfidence(bases({ cogs: 'actual' }), [warning('RESTOCK_UNKNOWN')]).level).toBe('estimated');
  });

  it('does not let an unconfirmed restock UPGRADE a COGS figure that is missing', () => {
    // `estimated` is a floor, not an assignment. Softening `missing` here would
    // walk an uncosted order back into loss-maker ranking.
    const result = deriveConfidence(bases({ cogs: 'missing' }), [warning('RESTOCK_UNKNOWN')]);
    expect(result.cogs).toBe('missing');
    expect(result.level).toBe('incomplete');
  });

  it('marks a reversal the engine had to allocate itself, and keeps that order out of exact', () => {
    // A warning that moved no term used to sit beside `level: exact`, badging a
    // number as definitive while the note beside it said otherwise.
    for (const code of ['REVERSAL_LINE_UNMATCHED', 'REVERSAL_TOTAL_MISMATCH'] as const) {
      const result = deriveConfidence(bases({ reversal: 'reported' }), [warning(code)]);
      expect(result.reversal).toBe('allocated');
      expect(result.level).toBe('estimated');
    }
  });
});

// -------------------------------------------------- the loss-maker gate ----

const fixture = (name: string): OrderProfitInput =>
  JSON.parse(
    readFileSync(join(import.meta.dirname, 'fixtures', 'golden', name, 'input.json'), 'utf8'),
  ) as OrderProfitInput;

const mutated = (name: string, fn: (input: Record<string, unknown>) => void): OrderProfitInput => {
  const input = fixture(name) as unknown as Record<string, unknown>;
  fn(input);
  return input as unknown as OrderProfitInput;
};

describe('isRankableForLossMaker', () => {
  it('excludes an order whose margin is a bound rather than a number', () => {
    // Fixture 0004 has no cost data at all and therefore reports a 94% margin.
    // Ranking it would put the store's least-known product at the top of a
    // feature whose whole point is telling the merchant what to stop selling.
    const result = computeOrderProfit(fixture('0004-no-cost-data'));
    expect(result.status === 'computed' && result.confidence.level).toBe('incomplete');
    expect(isRankableForLossMaker(result)).toBe(false);
  });

  it('includes an estimated order, which is the normal state', () => {
    // If `estimated` were excluded the feature would be empty on every store:
    // neither platform in scope reports courier cost or gateway fees.
    expect(isRankableForLossMaker(computeOrderProfit(fixture('0006-prepaid-card-baseline')))).toBe(true);
  });

  it('includes the genuinely loss-making order the feature exists to surface', () => {
    const result = computeOrderProfit(fixture('0014-loss-maker-negative-margin'));
    expect(result.status === 'computed' && result.totals.contributionMarginMinor).toBeLessThan(0);
    expect(isRankableForLossMaker(result)).toBe(true);
  });

  it('includes an exact order', () => {
    expect(isRankableForLossMaker(computeOrderProfit(fixture('0005-full-discount')))).toBe(true);
  });

  it('excludes an order the engine recognized nothing for', () => {
    // A test order has real numbers attached and none of them are the
    // merchant's. Nothing was bought and nothing was lost.
    const result = computeOrderProfit(mutated('0006-prepaid-card-baseline', (i) => {
      (i['order'] as Record<string, unknown>)['isTest'] = true;
    }));
    expect(result.status === 'computed' && result.recognition.kind).toBe('excluded');
    expect(isRankableForLossMaker(result)).toBe(false);
  });

  it('excludes a rejected result, which carries no totals to rank at all', () => {
    const result = computeOrderProfit(fixture('0010-rejected-currency-mismatch'));
    expect(result.status).toBe('rejected');
    expect(isRankableForLossMaker(result)).toBe(false);
  });
});

describe('marginBps', () => {
  it('is a rate a merchant can read, rounded the same way as the money it describes', () => {
    const result = computeOrderProfit(fixture('0006-prepaid-card-baseline'));
    expect(result.status === 'computed' && result.totals.marginBps).toBe(3_789);
    expect(divRoundHalfAway(23_681 * 10_000, 62_500)).toBe(3_789);
  });

  it('reports NO rate at all for an order that collected nothing', () => {
    // A ratio to zero is not 0%, it is nothing. Reporting zero would put every
    // refused parcel in the store at exactly break-even.
    const result = computeOrderProfit(mutated('0006-prepaid-card-baseline', (i) => {
      const order = i['order'] as Record<string, unknown>;
      order['paymentState'] = 'unpaid';
      order['fulfillmentState'] = 'rto';
    }));
    expect(result.status === 'computed' && result.recognition.kind).toBe('cost_only');
    expect(result.status === 'computed' && result.totals.revenueExVatMinor).toBe(0);
    expect(result.status === 'computed' && result.totals.marginBps).toBe(null);
  });

  it('reports no rate when a coupon exceeded everything the order charged', () => {
    // A SAR 700 coupon on a SAR 625 order. Revenue below zero flips the sign of
    // the ratio, so a loss divided by negative revenue reads as a healthy
    // positive rate — and this order would rank among the store's best.
    const result = computeOrderProfit(mutated('0006-prepaid-card-baseline', (i) => {
      (i['order'] as Record<string, unknown>)['discounts'] = [
        { code: 'OVERSHOOT', target: 'items', reflectedInComponent: false, amountExVatMinor: 70_000 },
      ];
    }));
    expect(result.status === 'computed' && result.totals.revenueExVatMinor).toBeLessThan(0);
    expect(result.status === 'computed' && result.totals.marginBps).toBe(null);
  });
});

// ---------------------------------------------------- the kernel’s guards ----

describe('the money kernel’s remaining guards', () => {
  it('refuses a sum that has left the range where integer arithmetic is exact', () => {
    // Past MAX_SAFE_INTEGER a `+` stops being exact and starts being close, with
    // no error anywhere — the one failure mode integer money exists to prevent.
    expect(() => addMinor(...Array.from({ length: 10_001 }, () => m(MAX_MINOR)))).toThrow(MoneyKernelError);
    // A thousand nine-million-riyal orders still sum exactly, which is the range
    // the guard exists to protect rather than to police.
    expect(addMinor(...Array.from({ length: 1_000 }, () => m(900_000_000)))).toBe(900_000_000_000);
  });

  it('rejects a rate typed as 2.75 instead of 275', () => {
    // The product guard cannot catch this: `value * 2.75` lands on an integer for
    // roughly half of all baskets, so the merchant would get a silently
    // 100x-wrong fee on those and a dead letter on the rest, partitioned by the
    // parity of the basket amount.
    expect(() => mulBps(m(57_500), 2.75 as unknown as Bps)).toThrow(MoneyKernelError);
    expect(mulBps(m(57_500), bp(275))).toBe(1_581);
  });

  it('refuses a fee bound that is not a finite number', () => {
    // `NaN < min` and `NaN > max` are both false, so a NaN bound does not clamp
    // loosely — it removes the clamp entirely, which is the opposite of a bound.
    expect(() => clampMinor(m(500), null, Number.NaN as unknown as Minor)).toThrow(MoneyKernelError);
    expect(() => clampMinor(m(500), Number.POSITIVE_INFINITY as unknown as Minor, null)).toThrow(MoneyKernelError);
  });

  it('refuses a divisor that would make a rate infinite or undefined', () => {
    expect(() => divRoundHalfAway(1_000, 0)).toThrow(MoneyKernelError);
    expect(() => divRoundHalfAway(1_000, -10)).toThrow(MoneyKernelError);
    expect(() => divRoundHalfAway(1_000, Number.NaN)).toThrow(MoneyKernelError);
    expect(() => divRoundHalfAway(1_000, 2.5)).toThrow(MoneyKernelError);
    expect(() => divRoundHalfAway(Number.MAX_SAFE_INTEGER + 2, 10)).toThrow(MoneyKernelError);
  });

  it('rounds a rate half away from zero, so a margin and its mirror image agree', () => {
    expect(divRoundHalfAway(15, 10)).toBe(2);
    expect(divRoundHalfAway(-15, 10)).toBe(-2);
  });

  it('names what went out of range, because the label is the only clue in a dead letter', () => {
    expect(() => assertInRange(MAX_MINOR + 1, 'COGS for demo:1:1001#L1')).toThrow(/COGS for demo:1:1001#L1/);
    expect(() => assertInRange(-MAX_MINOR - 1, 'COGS for demo:1:1001#L1')).toThrow(MoneyKernelError);
    expect(() => assertInRange(1.5, 'COGS for demo:1:1001#L1')).toThrow(MoneyKernelError);
    expect(assertInRange(MAX_MINOR, 'COGS for demo:1:1001#L1')).toBe(MAX_MINOR);
  });

  it('places the odd halalas on the same lines whichever order the lines arrive in', () => {
    // Ten equal lines and seven halalas to place. Breaking the tie on array
    // index would move per-SKU margins between recomputes of the same order.
    const buckets = Array.from({ length: 10 }, (_, i) => ({ key: `L${String(i).padStart(2, '0')}`, weight: m(1_000) }));
    const forward = allocateMinor(m(7), buckets);
    const reversed = allocateMinor(m(7), [...buckets].reverse());
    const carrying = (shares: ReadonlyMap<string, Minor>): readonly string[] =>
      [...shares].filter(([, share]) => share === 1).map(([key]) => key).sort();
    expect(carrying(forward)).toEqual(['L00', 'L01', 'L02', 'L03', 'L04', 'L05', 'L06']);
    expect(carrying(reversed)).toEqual(carrying(forward));
  });
});
