import { describe, expect, it } from 'vitest';
import {
  CanonicalOrderItemSchema,
  CanonicalReversalSchema,
  CanonicalStoreSchema,
  InstantSchema,
  MinorSchema,
  PaymentBreakdownSchema,
  RateBpsSchema,
  RawLabelSchema,
} from '../src/index.js';

const accepts = (schema: { safeParse: (v: unknown) => { success: boolean } }, value: unknown): boolean =>
  schema.safeParse(value).success;

/**
 * These exist because the drift audit structurally cannot see them: `z.infer`
 * erases refinements, so deleting a `.refine` leaves the audit, tsc and eslint
 * all green while the invariant it enforced silently stops being enforced.
 */
describe('primitive boundaries', () => {
  it('holds MinorSchema exactly at the safe-arithmetic ceiling', () => {
    expect(accepts(MinorSchema, 900_719_925_474)).toBe(true);
    expect(accepts(MinorSchema, 900_719_925_475)).toBe(false);
    expect(accepts(MinorSchema, -900_719_925_474)).toBe(true);
    expect(accepts(MinorSchema, 15.99)).toBe(false);
    expect(accepts(MinorSchema, '1500')).toBe(false);
  });

  it('normalizes negative zero, which a JSON fixture cannot show you', () => {
    const parsed = MinorSchema.parse(-0);
    expect(Object.is(parsed, 0)).toBe(true);
  });

  it('bounds a rate but not a margin', () => {
    expect(accepts(RateBpsSchema, 1_500)).toBe(true);
    expect(accepts(RateBpsSchema, -1_500)).toBe(false);
    expect(accepts(RateBpsSchema, 10_001)).toBe(false);
  });

  it('rejects a calendar date that does not exist', () => {
    expect(accepts(InstantSchema, '2026-02-30T00:00:00.000Z')).toBe(false);
    expect(accepts(InstantSchema, '2026-09-05T18:30:00.000Z')).toBe(true);
  });

  it('caps a verbatim platform label', () => {
    expect(accepts(RawLabelSchema, 'x'.repeat(120))).toBe(true);
    expect(accepts(RawLabelSchema, 'x'.repeat(121))).toBe(false);
  });
});

const store = {
  id: 'p:1',
  platform: 'example_platform',
  platformStoreId: '1',
  currency: 'SAR',
  timezone: 'Asia/Riyadh',
  vatRateBps: 1_500,
  vatRegistered: true,
  installedAt: '2026-01-01T00:00:00.000Z',
};

describe('strict objects', () => {
  it('accepts a well-formed store', () => {
    expect(accepts(CanonicalStoreSchema, store)).toBe(true);
  });

  it('rejects an unknown key rather than stripping it', () => {
    // A mapper that spreads a raw platform payload is how customer data gets in.
    // Stripping would make that mistake invisible; failing makes it a test.
    expect(accepts(CanonicalStoreSchema, { ...store, customerEmail: 'a@b.com' })).toBe(false);
  });

  it('rejects a negative VAT rate, which would make net exceed gross', () => {
    expect(accepts(CanonicalStoreSchema, { ...store, vatRateBps: -1_500 })).toBe(false);
  });
});

const payment = {
  instrument: 'card',
  scheme: 'mada',
  wallet: 'apple_pay',
  provider: 'example_psp',
  rawMethodLabel: 'apple_pay',
  state: 'captured',
  amountGrossMinor: 57_500,
  transactionRef: 'txn_1',
};

describe('PaymentBreakdown', () => {
  it('expresses a wallet-presented card, the case worth the whole four-field split', () => {
    expect(accepts(PaymentBreakdownSchema, payment)).toBe(true);
    expect(accepts(PaymentBreakdownSchema, { ...payment, scheme: 'visa' })).toBe(true);
    expect(accepts(PaymentBreakdownSchema, { ...payment, scheme: 'unknown' })).toBe(true);
  });

  it('requires a scheme for a card and forbids one everywhere else', () => {
    expect(accepts(PaymentBreakdownSchema, { ...payment, scheme: null })).toBe(false);
    expect(
      accepts(PaymentBreakdownSchema, {
        ...payment,
        instrument: 'cod',
        scheme: null,
        wallet: null,
        provider: null,
        rawMethodLabel: 'cod',
      }),
    ).toBe(true);
    expect(accepts(PaymentBreakdownSchema, { ...payment, instrument: 'cod' })).toBe(false);
  });

  it('expresses a fully discounted order', () => {
    expect(
      accepts(PaymentBreakdownSchema, {
        ...payment,
        instrument: 'free',
        scheme: null,
        wallet: null,
        provider: null,
        amountGrossMinor: 0,
        rawMethodLabel: 'free',
      }),
    ).toBe(true);
  });
});

const item = {
  id: 'p:1:9#L1',
  orderId: 'p:1:9',
  platformLineId: 'L1',
  platformProductId: 'P1',
  platformVariantId: null,
  sku: 'SKU-1',
  productName: 'قميص',
  quantity: 2,
  unitPriceExVatMinor: 10_000,
  grossLineExVatMinor: 20_000,
  lineDiscountExVatMinor: 2_000,
  lineTotalExVatMinor: 18_000,
};

describe('CanonicalOrderItem', () => {
  it('enforces lineTotal = gross - discount', () => {
    expect(accepts(CanonicalOrderItemSchema, item)).toBe(true);
    expect(accepts(CanonicalOrderItemSchema, { ...item, lineTotalExVatMinor: 17_999 })).toBe(false);
  });

  it('rejects a fractional or negative quantity at the ingestion edge', () => {
    expect(accepts(CanonicalOrderItemSchema, { ...item, quantity: 1.5 })).toBe(false);
    expect(accepts(CanonicalOrderItemSchema, { ...item, quantity: -1 })).toBe(false);
  });
});

const reversal = {
  id: 'p:1:9#rev:r1',
  orderId: 'p:1:9',
  platformReversalId: 'r1',
  kind: 'refund',
  reason: 'customer_return',
  rawReasonLabel: 'رد',
  occurredAt: '2026-02-01T00:00:00.000Z',
  amountExVatMinor: 9_000,
  shippingRefundExVatMinor: 0,
  codFeeRefundExVatMinor: 0,
  adjustmentExVatMinor: 0,
  vatMinor: 1_350,
  totalIncVatMinor: 10_350,
  lines: [{ orderItemId: 'p:1:9#L1', quantity: 1, amountExVatMinor: 9_000, restockOutcome: 'restocked_sellable' }],
  restockOutcome: 'restocked_sellable',
  platformUpdatedAt: null,
};

describe('CanonicalReversal', () => {
  it('accounts for every halala', () => {
    expect(accepts(CanonicalReversalSchema, reversal)).toBe(true);
    expect(accepts(CanonicalReversalSchema, { ...reversal, totalIncVatMinor: 10_351 })).toBe(false);
  });

  it('requires reversal lines to sum to the item revenue reversed', () => {
    expect(
      accepts(CanonicalReversalSchema, {
        ...reversal,
        lines: [{ ...reversal.lines[0], amountExVatMinor: 8_000 }],
      }),
    ).toBe(false);
  });

  it('accepts a goodwill adjustment attributable to no line', () => {
    expect(
      accepts(CanonicalReversalSchema, {
        ...reversal,
        amountExVatMinor: 0,
        adjustmentExVatMinor: 9_000,
        lines: null,
        restockOutcome: 'not_applicable',
      }),
    ).toBe(true);
  });
});
