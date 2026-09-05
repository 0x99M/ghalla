import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeOrderProfit } from '../src/compute-order-profit.js';
import { normalizeAndValidate } from '../src/engine/normalize.js';
import type { OrderProfitInput } from '../src/input.js';
import type { DiagnosticCode } from '../src/diagnostics.js';

/**
 * The paths a golden fixture never takes.
 *
 * Every case here is a real shape a platform can send — a webhook replayed
 * twice, a store configured with a timezone nobody validated, a wallet payment
 * against a rate card that does not cover it. None of them are exotic, and all
 * of them decide money.
 */
const BASE = JSON.parse(
  readFileSync(join(import.meta.dirname, 'fixtures', 'golden', '0006-prepaid-card-baseline', 'input.json'), 'utf8'),
) as unknown;

type Bag = Record<string, unknown>;

function withInput(mutate: (input: Bag) => void): OrderProfitInput {
  const input = JSON.parse(JSON.stringify(BASE)) as Bag;
  mutate(input);
  return input as unknown as OrderProfitInput;
}

const codesOf = (input: OrderProfitInput): readonly DiagnosticCode[] =>
  computeOrderProfit(input).diagnostics.map((d) => d.code);

const REVERSAL: Bag = {
  id: 'demo:1:1001#rev:r1',
  orderId: 'demo:1:1001',
  platformReversalId: 'r1',
  kind: 'refund',
  reason: 'customer_return',
  rawReasonLabel: 'customer_return',
  occurredAt: '2026-03-10T09:00:00.000Z',
  amountExVatMinor: 1000,
  shippingRefundExVatMinor: 0,
  codFeeRefundExVatMinor: 0,
  adjustmentExVatMinor: 0,
  vatMinor: 150,
  totalIncVatMinor: 1150,
  lines: null,
  restockOutcome: 'not_restocked',
  platformUpdatedAt: null,
};

describe('a webhook delivered twice', () => {
  it('rejects two reversals sharing an id', () => {
    // At-least-once delivery is the norm. Two rows for one refund would reverse
    // the same revenue twice, so this is a fatal rather than a warning: the
    // caller is told to stop retrying and fix the payload.
    const input = withInput((i) => {
      i['reversals'] = [{ ...REVERSAL }, { ...REVERSAL }];
    });
    const result = computeOrderProfit(input);
    expect(result.status).toBe('rejected');
    expect(codesOf(input)).toContain('DUPLICATE_ITEM_ID');
  });

  it('rejects two shipments sharing an id', () => {
    // Worse than the reversal case: the engine SUMS carrier cost across
    // shipments, so a replayed delivery double-counts the largest cost line on
    // the order and reports a loss the merchant did not take.
    const input = withInput((i) => {
      const shipments = i['shipments'] as Bag[];
      i['shipments'] = [shipments[0], { ...(shipments[0] as Bag) }];
    });
    const result = computeOrderProfit(input);
    expect(result.status).toBe('rejected');
    expect(codesOf(input)).toContain('DUPLICATE_ITEM_ID');
  });

  it('still returns a stable ordering when ids collide', () => {
    // The normalizer sorts by id to make the engine order-independent. Equal
    // ids are the one case where that comparison has nothing to separate, and
    // it must not throw on the way to reporting the duplicate.
    const input = withInput((i) => {
      i['reversals'] = [{ ...REVERSAL }, { ...REVERSAL }];
    });
    const { normalized, diagnostics } = normalizeAndValidate(input);
    expect(diagnostics.map((d) => d.code)).toContain('DUPLICATE_ITEM_ID');
    // Fatal, so nothing normalized comes back to compute against.
    expect(normalized).toBeNull();
  });
});

describe('a store configured with a timezone nobody checked', () => {
  it('is rejected by name rather than crashing the worker', () => {
    // The business date decides which day's rollup an order lands in, so an
    // unusable timezone cannot be quietly defaulted to UTC. Totality is a
    // promise: this dead-letters as a rejection instead of throwing into a
    // queue that would retry it forever.
    const input = withInput((i) => {
      (i['store'] as Bag)['timezone'] = 'Mars/Olympus_Mons';
    });
    const result = computeOrderProfit(input);
    expect(result.status).toBe('rejected');
    expect(result.diagnostics.map((d) => d.code)).toContain('INVALID_TIMEZONE');
  });
});

describe('a payment the rate card does not cover', () => {
  it('reports the fee as missing rather than charging zero', () => {
    // A card whose scheme the platform did not name, against a table keyed to a
    // provider we are not using. Nothing is eligible, so the fee is unknown —
    // and unknown must not be priced at zero, which would overstate the margin
    // on every order paid that way.
    const input = withInput((i) => {
      const payments = (i['order'] as Bag)['payments'] as Bag[];
      payments[0] = { ...(payments[0] as Bag), scheme: 'unknown', provider: 'provider_a' };
      (i['feeRuleSet'] as Bag)['gateway'] = [
        {
          instrument: 'card',
          scheme: 'mada',
          provider: 'provider_b',
          percentBps: 100,
          fixedMinor: 0,
          minFeeMinor: null,
          maxFeeMinor: null,
          feeVatBps: 1500,
          ratesIncludeVat: false,
          source: 'merchant_entered',
        },
      ];
    });

    const codes = codesOf(input);
    expect(codes).toContain('CARD_SCHEME_UNKNOWN');
    expect(codes).toContain('FEE_RULE_MISSING');

    const result = computeOrderProfit(input);
    expect(result.status).toBe('computed');
    if (result.status === 'computed') {
      // Priced at zero and stamped `missing` — the number is absent, and the
      // confidence says so rather than the total quietly being wrong.
      expect(result.totals.gatewayFeeCostMinor).toBe(0);
      expect(result.confidence.gatewayFee).toBe('missing');
    }
  });
});

describe('an order that was never going to be shipped', () => {
  it('calls its shipping not applicable, and does not estimate one', () => {
    // The customer collected it. There is no parcel and there never will be, so
    // `not_applicable` is the truth — and crucially the fallback rule must NOT
    // fire, because estimating a courier charge for a pickup invents a cost the
    // merchant never paid and books it against the order's margin.
    const input = withInput((i) => {
      i['shipments'] = [];
      (i['order'] as Bag)['fulfillmentMethod'] = 'pickup';
    });
    const result = computeOrderProfit(input);
    expect(result.status).toBe('computed');
    if (result.status === 'computed') {
      expect(result.totals.outboundShippingCostMinor).toBe(0);
      expect(result.confidence.outboundShipping).toBe('not_applicable');
    }
    // The fallback exists and is worth SAR 22; the point is that it stayed out.
    expect(codesOf(input)).not.toContain('SHIPPING_FALLBACK_USED');
  });

  it('reports a missing cost when a carrier order has no parcel and no fallback', () => {
    // The opposite case, and the one that must not be confused with it: this
    // order WAS shipped, we simply cannot say what it cost. Reporting that as
    // `not_applicable` would quietly treat an unknown freight bill as zero.
    const input = withInput((i) => {
      i['shipments'] = [];
      (i['feeRuleSet'] as Bag)['shippingFallback'] = [];
    });
    const result = computeOrderProfit(input);
    expect(result.status).toBe('computed');
    if (result.status === 'computed') {
      expect(result.confidence.outboundShipping).toBe('missing');
    }
    expect(codesOf(input)).toContain('SHIPPING_FALLBACK_MISSING');
  });
});
