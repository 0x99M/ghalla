import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MAX_MINOR, toInstant } from '@ghalla/contracts';
import type {
  CanonicalOrder,
  CanonicalShipment,
  Instant,
  OrderItemId,
  ReversalId,
  ShipmentId,
} from '@ghalla/contracts';
import { computeOrderProfit } from '../src/compute-order-profit.js';
import {
  InvalidTimezoneError,
  MalformedInstantError,
  businessDateOf,
  epochMillis,
} from '../src/engine/business-date.js';
import { diagnostic, severityOf, sortDiagnostics } from '../src/engine/diagnostics-builder.js';
import { normalizeAndValidate } from '../src/engine/normalize.js';
import { computeRecognition, isCostOnly, isExcluded } from '../src/engine/recognition.js';
import type { Diagnostic, DiagnosticCode } from '../src/diagnostics.js';
import type { OrderProfitInput } from '../src/input.js';
import type { ProfitRecognition } from '../src/result.js';

/**
 * Everything that decides whether an order is COMPUTED, REJECTED or not counted
 * at all: `normalizeAndValidate`, `computeRecognition`, the business-date
 * boundary, and the diagnostics ordering a golden fixture is compared against.
 *
 * A rejected result is a dead-letter signal — the caller is told to stop
 * retrying and fix the payload — so which fatal it names is merchant-facing
 * copy, not telemetry. Every case below asserts the CODE and its SUBJECT, not
 * merely that something went wrong.
 */

const BASE = JSON.parse(
  readFileSync(join(import.meta.dirname, 'fixtures', 'golden', '0006-prepaid-card-baseline', 'input.json'), 'utf8'),
) as unknown;

type Bag = Record<string, unknown>;

/**
 * One documented cast per harness, the same one `golden.test.ts` carries:
 * `JSON.parse` cannot produce branded types, and building the input through the
 * checked constructors would stop it being the plain JSON that ingestion will
 * actually hand the engine.
 */
function withInput(mutate: (input: Bag) => void): OrderProfitInput {
  const input = JSON.parse(JSON.stringify(BASE)) as Bag;
  mutate(input);
  return input as unknown as OrderProfitInput;
}

const orderOf = (input: Bag): Bag => input['order'] as Bag;
const storeOf = (input: Bag): Bag => input['store'] as Bag;
const feesOf = (input: Bag): Bag => input['feeRuleSet'] as Bag;
const firstItemOf = (input: Bag): Bag => (input['items'] as Bag[])[0] as Bag;

const codesOf = (input: OrderProfitInput): readonly DiagnosticCode[] =>
  computeOrderProfit(input).diagnostics.map((d) => d.code);

const timesReported = (input: OrderProfitInput, code: DiagnosticCode): number =>
  codesOf(input).filter((c) => c === code).length;

const gatewayRule = (over: Bag): Bag => ({
  instrument: 'card',
  scheme: 'mada',
  provider: null,
  percentBps: 100,
  fixedMinor: 0,
  minFeeMinor: null,
  maxFeeMinor: null,
  feeVatBps: 1500,
  ratesIncludeVat: false,
  source: 'merchant_entered',
  ...over,
});

const codRule = (over: Bag): Bag => ({
  carrier: null,
  percentBps: 200,
  fixedMinor: 800,
  minFeeMinor: null,
  maxFeeMinor: null,
  feeVatBps: 1500,
  ratesIncludeVat: false,
  source: 'merchant_entered',
  ...over,
});

const shippingRule = (over: Bag): Bag => ({
  countryCode: null,
  region: null,
  carrier: null,
  direction: 'any',
  costMinor: 2200,
  ...over,
});

const withGateway = (...rules: Bag[]): OrderProfitInput =>
  withInput((input) => {
    feesOf(input)['gateway'] = rules;
  });

const withCod = (...rules: Bag[]): OrderProfitInput =>
  withInput((input) => {
    feesOf(input)['cod'] = rules;
  });

const withShippingFallback = (...rules: Bag[]): OrderProfitInput =>
  withInput((input) => {
    feesOf(input)['shippingFallback'] = rules;
  });

const costRow = (over: Bag): Bag => ({
  platformProductId: 'P1',
  platformVariantId: null,
  sku: 'SKU-1',
  unitCostMinor: 18000,
  source: 'merchant_manual',
  costHistoryId: 'ch_1',
  ...over,
});

const withCosts = (...rows: Bag[]): OrderProfitInput =>
  withInput((input) => {
    input['costs'] = rows;
  });

const refund = (over: Bag): Bag => ({
  id: 'demo:1:1001#rev:r1',
  orderId: 'demo:1:1001',
  platformReversalId: 'r1',
  kind: 'refund',
  reason: 'customer_return',
  rawReasonLabel: null,
  occurredAt: '2026-03-10T09:00:00.000Z',
  amountExVatMinor: 30000,
  shippingRefundExVatMinor: 0,
  codFeeRefundExVatMinor: 0,
  adjustmentExVatMinor: 0,
  vatMinor: 4500,
  totalIncVatMinor: 34500,
  lines: null,
  restockOutcome: 'restocked_sellable',
  platformUpdatedAt: null,
  ...over,
});

const withReversals = (...rows: Bag[]): OrderProfitInput =>
  withInput((input) => {
    input['reversals'] = rows;
  });

// -------------------------------------------------------------------------
// normalizeAndValidate
// -------------------------------------------------------------------------

describe('the structural gate', () => {
  it('names only the malformed payload, not the defects it cannot yet see', () => {
    // Everything after the gate dereferences `feeRuleSet`, so the gate has to
    // return before it. A caller handed a truncated payload needs to fix the
    // payload; a list of consequential complaints about the parts that did
    // arrive sends them looking in the wrong place.
    const truncated = withInput((input) => {
      input['feeRuleSet'] = null;
      const item = firstItemOf(input);
      input['items'] = [item, { ...item }];
    });

    expect(computeOrderProfit(truncated).diagnostics).toStrictEqual([
      { code: 'MALFORMED_INPUT', severity: 'fatal', subject: { kind: 'order' } },
    ]);
  });

  it('still reports the order and store it was given, so the dead letter is traceable', () => {
    const noRules = withInput((input) => {
      delete input['feeRuleSet'];
    });
    const result = computeOrderProfit(noRules);

    expect(result.status).toBe('rejected');
    expect(result.orderId).toBe('demo:1:1001');
    expect(result.storeId).toBe('demo:1');
  });
});

describe('a currency the store does not keep its books in', () => {
  it('rejects a rate card transcribed in the wrong currency, even when the order agrees with the store', () => {
    // `Minor` is currency-free by design, and CURRENCY_CODES spans two- and
    // three-decimal currencies — so the same integer read against the wrong
    // card is a 10x different fee, and nothing downstream could ever tell.
    const foreignCard = withInput((input) => {
      feesOf(input)['currency'] = 'KWD';
    });

    expect(computeOrderProfit(foreignCard).diagnostics).toStrictEqual([
      { code: 'CURRENCY_MISMATCH', severity: 'fatal', subject: { kind: 'order' } },
    ]);
  });

  it('counts the order and the rate card as two separate facts to correct', () => {
    // Two independent transcriptions are wrong, and fixing one leaves the order
    // still unpriceable — so the caller is told about both at once rather than
    // discovering the second on the retry.
    const both = withInput((input) => {
      orderOf(input)['currency'] = 'AED';
      feesOf(input)['currency'] = 'AED';
    });

    expect(timesReported(both, 'CURRENCY_MISMATCH')).toBe(2);
  });

  /**
   * BUG. Both checks are equality checks, and three absent currencies agree with
   * one another — so an order carrying no currency anywhere is COMPUTED, and the
   * result reports `currency: undefined` on a field typed `CurrencyCode`. An
   * absent currency is not a lesser problem than a mismatched one: `Minor` is
   * currency-free by design and CURRENCY_CODES spans two- and three-decimal
   * currencies, so nothing downstream can recover which one these halalas were.
   */
  it('rejects an order with no currency at all, not only one that disagrees', () => {
    const currencyless = withInput((input) => {
      delete storeOf(input)['currency'];
      delete orderOf(input)['currency'];
      delete feesOf(input)['currency'];
    });

    expect(computeOrderProfit(currencyless).status).toBe('rejected');
  });
});

describe('the clock the business date is measured on', () => {
  it('rejects an empty timezone rather than falling back to the machine that ran the job', () => {
    // An absent zone reaches Intl as `undefined`, which means "use the runtime
    // default" — and a merchant's daily figures would then depend on which
    // worker picked up the job.
    const noZone = withInput((input) => {
      storeOf(input)['timezone'] = '';
    });

    expect(codesOf(noZone)).toContain('INVALID_TIMEZONE');
  });

  it('blames the timestamp, not the timezone, when an adapter sends epoch milliseconds', () => {
    // DIAGNOSTIC_CODES becomes dashboard copy. Telling a merchant their
    // timezone is broken sends them to a settings screen that is perfectly fine.
    const epochNumber = withInput((input) => {
      orderOf(input)['placedAt'] = 1_772_389_800_000;
    });
    const codes = codesOf(epochNumber);

    expect(codes).toContain('MALFORMED_TIMESTAMP');
    expect(codes).not.toContain('INVALID_TIMEZONE');
  });

  it('rejects a time of day that does not exist', () => {
    const noSuchHour = withInput((input) => {
      orderOf(input)['placedAt'] = '2026-03-01T24:00:00.000Z';
    });

    expect(codesOf(noSuchHour)).toContain('MALFORMED_TIMESTAMP');
  });
});

describe('a rate card the engine cannot apply', () => {
  it('rejects a fee VAT rate above 100 per cent', () => {
    // 15000 is what a merchant types when they read 15% as 15000 basis points
    // of something else. Applied, it charges ten times the VAT actually due on
    // the fee, in the direction that understates their margin.
    expect(codesOf(withGateway(gatewayRule({ feeVatBps: 15_000 })))).toContain('FEE_RULE_INVALID');
  });

  it('rejects a fractional or negative fee VAT rate', () => {
    expect(codesOf(withGateway(gatewayRule({ feeVatBps: 1500.5 })))).toContain('FEE_RULE_INVALID');
    expect(codesOf(withGateway(gatewayRule({ feeVatBps: -1500 })))).toContain('FEE_RULE_INVALID');
  });

  it('rejects a negative fixed fee, which would pay the merchant to take a card', () => {
    expect(codesOf(withGateway(gatewayRule({ fixedMinor: -100 })))).toContain('FEE_RULE_INVALID');
  });

  it('rejects a negative floor or cap on a fee', () => {
    expect(codesOf(withGateway(gatewayRule({ minFeeMinor: -100 })))).toContain('FEE_RULE_INVALID');
    expect(codesOf(withGateway(gatewayRule({ maxFeeMinor: -20_000 })))).toContain('FEE_RULE_INVALID');
  });

  it('rejects a floor above its cap', () => {
    // Transposing the two is the natural slip, and the clamp applies the cap
    // last: SAR 199 of margin invented on a single order, silently.
    expect(codesOf(withGateway(gatewayRule({ minFeeMinor: 20_000, maxFeeMinor: 100 })))).toContain(
      'FEE_RULE_INVALID',
    );
  });

  it('accepts a floor equal to its cap, which is how a flat per-transaction fee is written', () => {
    const flat = withGateway(gatewayRule({ minFeeMinor: 500, maxFeeMinor: 500 }));

    expect(computeOrderProfit(flat).status).toBe('computed');
    expect(codesOf(flat)).not.toContain('FEE_RULE_INVALID');
  });

  it('rejects a shipping fallback that would pay the merchant to send a parcel', () => {
    expect(codesOf(withShippingFallback(shippingRule({ costMinor: -2200 })))).toContain('FEE_RULE_INVALID');
  });

  it('rejects a shipping fallback cost that is not a whole halala or is beyond the safe range', () => {
    // Half a halala cannot be charged, and a transcription slip of a few extra
    // zeros must not silently degrade the arithmetic every parcel passes through.
    expect(codesOf(withShippingFallback(shippingRule({ costMinor: 2200.5 })))).toContain('FEE_RULE_INVALID');
    expect(codesOf(withShippingFallback(shippingRule({ costMinor: MAX_MINOR + 1 })))).toContain('FEE_RULE_INVALID');
  });
});

describe('two rules that both claim the same order', () => {
  it('rejects a second catch-all gateway rule rather than letting row order price the fee', () => {
    // Both rows match every payment, so which one applies depends on the order
    // the caller's query returned. Sorting would hide the merchant's duplicated
    // rate; rejecting surfaces it.
    const ambiguous = withGateway(
      gatewayRule({ instrument: null, scheme: null, provider: null, percentBps: 100 }),
      gatewayRule({ instrument: null, scheme: null, provider: null, percentBps: 275 }),
    );

    expect(codesOf(ambiguous)).toContain('DUPLICATE_RULE_KEY');
  });

  it('does not confuse two rules that differ only by processor', () => {
    // Provider is a real key: the same mada card genuinely prices differently
    // through two processors, and refusing that configuration would make the
    // 0023 provider-specific-rates shape unrepresentable.
    const perProvider = withGateway(
      gatewayRule({ provider: 'demo_gateway_a' }),
      gatewayRule({ provider: 'demo_gateway_b', percentBps: 275 }),
    );

    expect(codesOf(perProvider)).not.toContain('DUPLICATE_RULE_KEY');
  });

  it('rejects two cash-on-delivery rules for the same carrier', () => {
    expect(codesOf(withCod(codRule({ carrier: 'demo_courier' }), codRule({ carrier: 'demo_courier' })))).toContain(
      'DUPLICATE_RULE_KEY',
    );
  });

  it('accepts one cash-on-delivery rule per carrier, which is the whole reason it is keyed by carrier', () => {
    // Couriers a single store uses on the same day quote different COD rates; a
    // flat store-level constant diverges across the basket-size distribution.
    const perCarrier = withCod(
      codRule({ carrier: 'demo_courier' }),
      codRule({ carrier: 'other_courier', fixedMinor: 1200 }),
      codRule({ carrier: null }),
    );

    expect(codesOf(perCarrier)).not.toContain('DUPLICATE_RULE_KEY');
  });

  /**
   * BUG. `validateFeeRuleSet` checks for duplicate keys on the gateway and COD
   * arrays but not on `shippingFallback`, and `matchShippingRule` keeps the
   * FIRST rule of the highest specificity score. Two catch-all rows therefore
   * price every parcel by whichever the caller's query returned first — exactly
   * the failure DUPLICATE_RULE_KEY exists to prevent, on the term that carries
   * the dominant Saudi loss shape.
   */
  it('rejects two shipping fallback rows with the same key, as it does for a rate', () => {
    const ambiguous = withShippingFallback(shippingRule({ costMinor: 2200 }), shippingRule({ costMinor: 9900 }));

    expect(codesOf(ambiguous)).toContain('DUPLICATE_RULE_KEY');
  });
});

describe('order lines the caller got wrong', () => {
  it('rejects a line belonging to another order rather than counting its cost here', () => {
    // A merchant-data gap is a warning they can act on; a line from a different
    // order is an adapter bug, and retrying it produces the same wrong margin
    // forever.
    const foreign = withInput((input) => {
      firstItemOf(input)['orderId'] = 'demo:1:9999';
    });

    expect(computeOrderProfit(foreign).diagnostics).toStrictEqual([
      { code: 'ITEM_ORDER_ID_MISMATCH', severity: 'fatal', subject: { kind: 'line', orderItemId: 'demo:1:1001#L1' } },
    ]);
  });

  it('names the duplicated line rather than dead-lettering it as an engine bug', () => {
    // The allocator throws on a duplicate key, and that throw would surface as
    // INTERNAL_INVARIANT_VIOLATED — blaming the engine for an upsert bug.
    const doubled = withInput((input) => {
      const item = firstItemOf(input);
      input['items'] = [item, { ...item }];
    });
    const result = computeOrderProfit(doubled);

    expect(result.diagnostics).toContainEqual({
      code: 'DUPLICATE_ITEM_ID',
      severity: 'fatal',
      subject: { kind: 'line', orderItemId: 'demo:1:1001#L1' },
    });
    expect(result.diagnostics.map((d) => d.code)).not.toContain('INTERNAL_INVARIANT_VIOLATED');
  });

  it('says negative when a quantity is negative and non-integer when it is not', () => {
    // The two codes are dashboard copy in Arabic. Telling a merchant they have
    // "2.5 of a thing" when the platform sent −1 is untrue, and sends them
    // hunting for a fractional quantity that does not exist.
    const negative = withInput((input) => {
      firstItemOf(input)['quantity'] = -1;
    });
    const codes = codesOf(negative);

    expect(codes).toContain('NEGATIVE_QUANTITY');
    expect(codes).not.toContain('NON_INTEGER_QUANTITY');
  });

  it('rejects a line total that is not a whole halala', () => {
    // A fraction here is not a rounding nicety: it propagates through every
    // allocation weight and every per-SKU margin on the order.
    const fractional = withInput((input) => {
      firstItemOf(input)['lineTotalExVatMinor'] = 60_000.5;
    });

    expect(computeOrderProfit(fractional).diagnostics).toStrictEqual([
      {
        code: 'NON_INTEGER_MINOR_UNITS',
        severity: 'fatal',
        subject: { kind: 'line', orderItemId: 'demo:1:1001#L1' },
      },
    ]);
  });
});

describe('shipments, reversals and cost rows the caller got wrong', () => {
  it('names the parcel whose courier charge is not a whole halala', () => {
    const fractional = withInput((input) => {
      ((input['shipments'] as Bag[])[0] as Bag)['carrierCostMinor'] = 2100.5;
    });

    expect(computeOrderProfit(fractional).diagnostics).toStrictEqual([
      { code: 'NON_INTEGER_MINOR_UNITS', severity: 'fatal', subject: { kind: 'shipment', shipmentId: 'demo:1:S1' } },
    ]);
  });

  it('treats an unbilled parcel as a gap in merchant data, not a caller defect', () => {
    // The courier's invoice lands days after the order. A null charge must
    // degrade confidence and prompt for a rate card, never dead-letter the order.
    const unbilled = withInput((input) => {
      ((input['shipments'] as Bag[])[0] as Bag)['carrierCostMinor'] = null;
    });
    const result = computeOrderProfit(unbilled);

    expect(result.status).toBe('computed');
    expect(result.diagnostics.every((d) => d.severity === 'warning')).toBe(true);
  });

  it('names the reversal whose line amount is not a whole halala', () => {
    const fractional = withReversals(
      refund({
        lines: [
          {
            orderItemId: 'demo:1:1001#L1',
            quantity: 1,
            amountExVatMinor: 30_000.5,
            restockOutcome: 'restocked_sellable',
          },
        ],
      }),
    );

    expect(computeOrderProfit(fractional).diagnostics).toStrictEqual([
      {
        code: 'NON_INTEGER_MINOR_UNITS',
        severity: 'fatal',
        subject: { kind: 'reversal', reversalId: 'demo:1:1001#rev:r1' },
      },
    ]);
  });

  it('rejects a fractional quantity on a reversal line', () => {
    // The refunded quantity bounds the COGS credit, so half a unit returned
    // would credit half an item's cost back and lift the margin on a refund.
    const fractional = withReversals(
      refund({
        lines: [
          {
            orderItemId: 'demo:1:1001#L1',
            quantity: 1.5,
            amountExVatMinor: 30_000,
            restockOutcome: 'restocked_sellable',
          },
        ],
      }),
    );

    expect(codesOf(fractional)).toContain('NON_INTEGER_QUANTITY');
  });

  /**
   * BUG. A negative quantity on a REVERSAL line is reported as
   * NON_INTEGER_QUANTITY, though −1 is an integer. The same value on an ORDER
   * line is correctly reported as NEGATIVE_QUANTITY, and DIAGNOSTIC_CODES
   * documents NON_INTEGER_QUANTITY as "Distinct from negative … naming it
   * NEGATIVE_QUANTITY would tell a merchant something untrue" — which is exactly
   * what this path does, in the other direction.
   */
  it('says negative when a reversal line quantity is negative', () => {
    const negative = withReversals(
      refund({
        lines: [
          {
            orderItemId: 'demo:1:1001#L1',
            quantity: -1,
            amountExVatMinor: 30_000,
            restockOutcome: 'restocked_sellable',
          },
        ],
      }),
    );

    expect(codesOf(negative)).toContain('NEGATIVE_QUANTITY');
  });

  it('treats an omitted reversals array as an order nothing came back from', () => {
    // Adapters routinely leave an empty collection out of the payload entirely.
    // Reading that as a malformed input would dead-letter the healthy majority
    // of every store's orders.
    const noReversalsKey = withInput((input) => {
      delete input['reversals'];
    });
    const result = computeOrderProfit(noReversalsKey);

    expect(result.status).toBe('computed');
    if (result.status !== 'computed') return;
    expect(result.totals.reversalImpactMinor).toBe(0);
  });

  it('rejects a unit cost that is not a whole halala', () => {
    expect(codesOf(withCosts(costRow({ unitCostMinor: 18_000.5 })))).toContain('NON_INTEGER_MINOR_UNITS');
  });

  it('rejects two cost rows for one product key rather than taking whichever came back last', () => {
    // Two rows for one key means the as-of query returned overlapping validity
    // windows. Taking the last would make last quarter's profit depend on the
    // order the database happened to return.
    const overlapping = withCosts(costRow({ costHistoryId: 'ch_1' }), costRow({ costHistoryId: 'ch_2', sku: null }));

    expect(codesOf(overlapping)).toContain('DUPLICATE_COST_KEY');
  });

  it('rejects two cost rows sharing a SKU, even under different product keys', () => {
    // SKU is the secondary resolution key for platforms whose order lines carry
    // no variant identity, so an ambiguous SKU is just as unusable as an
    // ambiguous product key.
    const sharedSku = withCosts(
      costRow({ platformProductId: 'P1', sku: 'SKU-1' }),
      costRow({ platformProductId: 'P2', sku: 'SKU-1', costHistoryId: 'ch_2' }),
    );

    expect(codesOf(sharedSku)).toContain('DUPLICATE_COST_KEY');
  });

  it('does not treat two rows with no SKU as a collision', () => {
    // A blank SKU is an absence, not a key. Merchants leave it empty on most of
    // the catalogue, and rejecting on it would dead-letter their whole store.
    const noSkus = withCosts(
      costRow({ platformProductId: 'P1', sku: null }),
      costRow({ platformProductId: 'P2', sku: '', costHistoryId: 'ch_2' }),
    );

    expect(codesOf(noSkus)).not.toContain('DUPLICATE_COST_KEY');
  });
});

describe('the ordering every allocation depends on', () => {
  const line = (lineId: string): Bag => ({
    id: `demo:1:1001#${lineId}`,
    orderId: 'demo:1:1001',
    platformLineId: lineId,
    platformProductId: 'P1',
    platformVariantId: null,
    sku: 'SKU-1',
    productName: 'منتج',
    quantity: 1,
    unitPriceExVatMinor: 20_000,
    grossLineExVatMinor: 20_000,
    lineDiscountExVatMinor: 0,
    lineTotalExVatMinor: 20_000,
  });

  const parcel = (shipmentId: string): Bag => ({
    id: `demo:1:${shipmentId}`,
    orderId: 'demo:1:1001',
    platformShipmentId: shipmentId,
    direction: 'outbound',
    status: 'delivered',
    carrier: 'demo_courier',
    rawCarrierLabel: 'Demo Courier',
    carrierCostMinor: 700,
    lines: [],
    shippedAt: '2026-03-02T06:00:00.000Z',
    deliveredAt: '2026-03-03T06:00:00.000Z',
    platformUpdatedAt: null,
  });

  it('sorts items, shipments and reversals into a canonical order whatever order they arrived in', () => {
    // Largest-remainder allocation breaks ties on remainder, then weight, then
    // key — never array index. That guarantee is worth nothing if the array
    // itself reaches the allocator in whatever order a webhook payload listed.
    const shuffled = withInput((input) => {
      input['items'] = [line('L3'), line('L1'), line('L2')];
      input['shipments'] = [parcel('S2'), parcel('S3'), parcel('S1')];
      const nothingRefunded = { amountExVatMinor: 0, vatMinor: 0, totalIncVatMinor: 0 };
      input['reversals'] = [
        refund({ id: 'demo:1:1001#rev:r2', platformReversalId: 'r2', ...nothingRefunded }),
        refund({ id: 'demo:1:1001#rev:r1', ...nothingRefunded }),
      ];
    });

    const { normalized } = normalizeAndValidate(shuffled);
    if (normalized === null) throw new Error('expected a well-formed order to normalize');

    expect(normalized.items.map((i) => i.platformLineId)).toEqual(['L1', 'L2', 'L3']);
    expect(normalized.shipments.map((s) => s.id)).toEqual(['demo:1:S1', 'demo:1:S2', 'demo:1:S3']);
    expect(normalized.reversals.map((r) => r.id)).toEqual(['demo:1:1001#rev:r1', 'demo:1:1001#rev:r2']);
  });

  it('gives the same margin whichever order two reversals arrive in', () => {
    // Reversals are applied in sequence and each one's COGS credit is clamped by
    // what earlier ones already took back, so processing order is worth real
    // money: here, SAR 180 of restocked cost on a single order.
    const full = refund({
      id: 'demo:1:1001#rev:r1',
      platformReversalId: 'r1',
      amountExVatMinor: 60_000,
      vatMinor: 9000,
      totalIncVatMinor: 69_000,
      lines: [
        { orderItemId: 'demo:1:1001#L1', quantity: 2, amountExVatMinor: 60_000, restockOutcome: 'restocked_sellable' },
      ],
    });
    const writeOff = refund({
      id: 'demo:1:1001#rev:r2',
      platformReversalId: 'r2',
      amountExVatMinor: 0,
      vatMinor: 0,
      totalIncVatMinor: 0,
      lines: [
        { orderItemId: 'demo:1:1001#L1', quantity: 1, amountExVatMinor: 0, restockOutcome: 'restocked_scrapped' },
      ],
    });

    expect(computeOrderProfit(withReversals(writeOff, full))).toStrictEqual(
      computeOrderProfit(withReversals(full, writeOff)),
    );
  });
});

// -------------------------------------------------------------------------
// computeRecognition
// -------------------------------------------------------------------------

const anOrder = (over: Partial<CanonicalOrder>): CanonicalOrder =>
  ({
    isTest: false,
    lifecycle: 'open',
    paymentState: 'paid',
    fulfillmentState: 'delivered',
    ...over,
  }) as CanonicalOrder;

const aShipment = (over: Partial<CanonicalShipment>): CanonicalShipment =>
  ({ direction: 'outbound', status: 'delivered', ...over }) as CanonicalShipment;

describe('what an order contributes, and what it does not', () => {
  const recognized: ProfitRecognition = { kind: 'recognized' };
  const costOnly: ProfitRecognition = { kind: 'cost_only', reason: 'rto_uncollected' };
  const excluded: ProfitRecognition = { kind: 'excluded', reason: 'draft' };

  it('separates an order whose costs count from one that counts for nothing', () => {
    // The distinction gates loss-maker ranking and every average-order-value
    // denominator: a cost-only order must drag margin down without diluting
    // revenue, and an excluded one must not appear in either.
    expect([recognized, costOnly, excluded].map(isCostOnly)).toEqual([false, true, false]);
    expect([recognized, costOnly, excluded].map(isExcluded)).toEqual([false, false, true]);
  });

  it('keeps a lost parcel the customer already paid for as a sale', () => {
    // The cash is in the merchant's hand. The loss is the goods, which COGS
    // already carries — zeroing the revenue as well would double-count it.
    expect(computeRecognition(anOrder({ paymentState: 'paid' }), [aShipment({ status: 'lost' })])).toEqual({
      kind: 'recognized',
    });
  });

  it('does not write off a whole order because one of two parcels was lost', () => {
    const partlyLost = [aShipment({ status: 'lost' }), aShipment({ status: 'delivered' })];

    expect(computeRecognition(anOrder({ paymentState: 'unpaid' }), partlyLost)).toEqual({ kind: 'recognized' });
  });

  it('ignores a cancelled leg when deciding whether the goods are gone', () => {
    // A label printed and voided never carried anything, so it is not evidence
    // that something is still in the network.
    const lostAfterAReprint = [aShipment({ status: 'cancelled' }), aShipment({ status: 'lost' })];

    expect(computeRecognition(anOrder({ paymentState: 'unpaid' }), lostAfterAReprint)).toEqual({
      kind: 'cost_only',
      reason: 'goods_lost',
    });
  });

  it('does not read a lost return leg as the outbound goods going missing', () => {
    // The customer received the item; it is the return journey that failed.
    // Writing the sale off would hand the merchant back revenue they kept.
    expect(
      computeRecognition(anOrder({ paymentState: 'unpaid' }), [aShipment({ direction: 'return', status: 'lost' })]),
    ).toEqual({ kind: 'recognized' });
  });

  it('treats a cancelled order that was refunded the same as one that was captured', () => {
    // Money moved and came back. The gateway fee and the outbound leg are spent
    // either way, so the costs count and the revenue does not.
    expect(computeRecognition(anOrder({ lifecycle: 'cancelled', paymentState: 'refunded' }), [])).toEqual({
      kind: 'cost_only',
      reason: 'cancelled_after_capture',
    });
  });

  it('does not book revenue for a voided payment on a delivered order', () => {
    // The goods left the warehouse and the money never settled: the costs are
    // real and the sale is not.
    expect(computeRecognition(anOrder({ paymentState: 'voided', fulfillmentState: 'delivered' }), [])).toEqual({
      kind: 'cost_only',
      reason: 'payment_not_settled',
    });
  });

  it('recognizes an ordinary completed order', () => {
    expect(computeRecognition(anOrder({ lifecycle: 'completed' }), [])).toEqual({ kind: 'recognized' });
  });
});

// -------------------------------------------------------------------------
// business-date
// -------------------------------------------------------------------------

describe('epochMillis', () => {
  it('counts from the epoch itself and keeps the milliseconds', () => {
    expect(epochMillis(toInstant('1970-01-01T00:00:00.000Z'))).toBe(0);
    expect(epochMillis(toInstant('2026-03-01T18:30:00.000Z'))).toBe(1_772_389_800_000);
    // Dropping the sub-second field would move an order placed at 23:59:59.999
    // into the wrong business day at the boundary.
    expect(epochMillis(toInstant('2026-03-01T18:30:00.001Z'))).toBe(1_772_389_800_001);
  });

  it('stays continuous across the epoch, where the era arithmetic changes sign', () => {
    expect(epochMillis(toInstant('1969-12-31T23:59:59.999Z'))).toBe(-1);
  });

  it('refuses a date that does not exist rather than rolling it into the next month', () => {
    // `new Date('2026-02-30')` silently becomes 2 March, which is the wrong
    // behaviour for a validator and would file the order under the wrong day.
    expect(() => epochMillis('2026-02-30T00:00:00.000Z' as Instant)).toThrow(MalformedInstantError);
  });

  it('refuses the shapes an adapter is most likely to send instead', () => {
    // Offsets are rejected outright: accepting them means every comparison in
    // the system has to remember to normalize first, and the one that forgets
    // is a silent three-hour error in a country that is UTC+3.
    expect(() => epochMillis('2026-03-01T18:30:00Z' as Instant)).toThrow(MalformedInstantError);
    expect(() => epochMillis('2026-03-01T21:30:00.000+03:00' as Instant)).toThrow(MalformedInstantError);
  });
});

describe('businessDateOf', () => {
  it('refuses an absent timezone instead of silently using the runtime default', () => {
    // `timeZone: undefined` means "use whatever this machine is set to", so a
    // worker in Frankfurt and one in Riyadh would file the same order under
    // different days.
    expect(() => businessDateOf(toInstant('2026-03-01T21:30:00.000Z'), '')).toThrow(InvalidTimezoneError);
    expect(() => businessDateOf(toInstant('2026-03-01T21:30:00.000Z'), undefined as unknown as string)).toThrow(
      InvalidTimezoneError,
    );
  });

  it('distinguishes a broken zone from a broken timestamp', () => {
    // The two send a merchant to different screens, so they must not collapse
    // into one error type.
    expect(() => businessDateOf(toInstant('2026-03-01T00:00:00.000Z'), 'Mars/Olympus')).toThrow(InvalidTimezoneError);
    expect(() => epochMillis('2026-02-30T00:00:00.000Z' as Instant)).not.toThrow(InvalidTimezoneError);
  });

  it('puts the same instant on different days for two stores', () => {
    // The business date is denormalized onto the order precisely because it is
    // a property of the STORE, not of the instant.
    const instant = toInstant('2026-03-01T02:00:00.000Z');

    expect(businessDateOf(instant, 'Asia/Riyadh')).toBe('2026-03-01');
    expect(businessDateOf(instant, 'America/Los_Angeles')).toBe('2026-02-28');
  });

  it('gets the Gregorian century rule right', () => {
    // 2100 is divisible by four and is NOT a leap year. The civil-day algorithm
    // is where that rule lives, and getting it wrong shifts every date after it
    // by a day.
    expect(businessDateOf(toInstant('2100-02-28T21:00:00.000Z'), 'Asia/Riyadh')).toBe('2100-03-01');
    expect(businessDateOf(toInstant('2000-02-28T21:00:00.000Z'), 'Asia/Riyadh')).toBe('2000-02-29');
  });
});

// -------------------------------------------------------------------------
// diagnostics-builder
// -------------------------------------------------------------------------

describe('sortDiagnostics', () => {
  const onLine = (code: DiagnosticCode, id: string): Diagnostic =>
    diagnostic(code, { kind: 'line', orderItemId: id as OrderItemId });
  const onShipment = (code: DiagnosticCode, id: string): Diagnostic =>
    diagnostic(code, { kind: 'shipment', shipmentId: id as ShipmentId });
  const onReversal = (code: DiagnosticCode, id: string): Diagnostic =>
    diagnostic(code, { kind: 'reversal', reversalId: id as ReversalId });
  const onPayment = (code: DiagnosticCode, index: number): Diagnostic =>
    diagnostic(code, { kind: 'payment', index });

  it('puts every subject kind in one canonical order', () => {
    // A diagnostics array is compared byte for byte in a golden fixture, so the
    // order must come from the data rather than from which sub-computation
    // happened to run first.
    const arrived: readonly Diagnostic[] = [
      onReversal('RESTOCK_UNKNOWN', 'R1'),
      onPayment('UNKNOWN_PAYMENT_INSTRUMENT', 0),
      onShipment('CARRIER_COST_MISSING', 'S1'),
      diagnostic('ORDER_HAS_NO_ITEMS', { kind: 'order' }),
      onLine('COST_MISSING', 'L1'),
    ];

    expect(sortDiagnostics(arrived).map((d) => d.subject.kind)).toEqual([
      'line',
      'order',
      'payment',
      'reversal',
      'shipment',
    ]);
  });

  it('orders payment legs numerically, not as text', () => {
    // A merchant-facing "second payment" must mean the same leg across
    // re-ingests. Sorting the indices as strings puts leg 10 before leg 2.
    const legs = [onPayment('CARD_SCHEME_UNKNOWN', 10), onPayment('CARD_SCHEME_UNKNOWN', 2)];

    expect(sortDiagnostics(legs).map((d) => (d.subject.kind === 'payment' ? d.subject.index : -1))).toEqual([2, 10]);
  });

  it('breaks a tie on the code, so two findings about one line never swap', () => {
    const sameLine = [onLine('REVERSAL_LINE_UNMATCHED', 'L1'), onLine('COST_MISSING', 'L1')];

    expect(sortDiagnostics(sameLine).map((d) => d.code)).toEqual(['COST_MISSING', 'REVERSAL_LINE_UNMATCHED']);
  });

  it('reaches the same order from any starting order, and loses nothing on the way', () => {
    // Dropping a diagnostic silently would remove a merchant's call to action —
    // "no cost recorded for this SKU" is the product's activation loop.
    const arrived: readonly Diagnostic[] = [
      onShipment('CARRIER_COST_MISSING', 'S2'),
      onLine('COST_ESTIMATED', 'L2'),
      onReversal('RESTOCK_UNKNOWN', 'R2'),
      onShipment('CARRIER_COST_MISSING', 'S1'),
      onReversal('RESTOCK_UNKNOWN', 'R1'),
      onLine('COST_MISSING', 'L1'),
      diagnostic('TOTALS_DO_NOT_RECONCILE', { kind: 'order' }),
    ];
    const sorted = sortDiagnostics(arrived);

    expect(sorted).toHaveLength(arrived.length);
    expect(sorted.map((d) => (d.subject.kind === 'reversal' ? d.subject.reversalId : null)).filter(Boolean)).toEqual([
      'R1',
      'R2',
    ]);
    expect(sortDiagnostics([...arrived].reverse())).toStrictEqual(sorted);
    expect(sortDiagnostics(sorted)).toStrictEqual(sorted);
  });

  it('does not mutate the array it was handed', () => {
    const arrived = [onLine('COST_MISSING', 'L2'), onLine('COST_MISSING', 'L1')];
    sortDiagnostics(arrived);

    expect(arrived.map((d) => (d.subject.kind === 'line' ? d.subject.orderItemId : ''))).toEqual(['L2', 'L1']);
  });
});

describe('severityOf', () => {
  it('calls a gap in merchant data a warning, because the merchant can close it', () => {
    // These carry usable numbers at lower confidence. Dead-lettering an order
    // for an uncosted SKU would remove it from the dashboard entirely, which is
    // strictly worse than a flagged estimate.
    expect(severityOf('COST_MISSING')).toBe('warning');
    expect(severityOf('CARRIER_COST_MISSING')).toBe('warning');
    expect(severityOf('FEE_RULE_MISSING')).toBe('warning');
  });

  it('calls a caller defect fatal, because retrying it produces the same wrong answer', () => {
    expect(severityOf('CURRENCY_MISMATCH')).toBe('fatal');
    expect(severityOf('MALFORMED_INPUT')).toBe('fatal');
    expect(severityOf('INTERNAL_INVARIANT_VIOLATED')).toBe('fatal');
  });

  it('stamps a diagnostic with the severity its code carries, so the two cannot drift', () => {
    expect(diagnostic('COST_MISSING', { kind: 'order' }).severity).toBe('warning');
    expect(diagnostic('DUPLICATE_COST_KEY', { kind: 'order' }).severity).toBe('fatal');
  });
});
