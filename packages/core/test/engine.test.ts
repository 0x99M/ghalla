import { describe, expect, it } from 'vitest';
import { toInstant } from '@ghalla/contracts';
import type { CanonicalOrder, CanonicalShipment } from '@ghalla/contracts';
import { businessDateOf } from '../src/engine/business-date.js';
import { computeRecognition } from '../src/engine/recognition.js';

describe('businessDateOf', () => {
  it('files a late-evening order under the merchant’s day, not UTC’s', () => {
    // 21:30 UTC is 00:30 the next day in Riyadh. Bucketing by UTC would make
    // Ghalla's "yesterday" disagree with the merchant's own dashboard daily.
    expect(businessDateOf(toInstant('2026-03-01T21:30:00.000Z'), 'Asia/Riyadh')).toBe('2026-03-02');
    expect(businessDateOf(toInstant('2026-03-01T20:59:59.999Z'), 'Asia/Riyadh')).toBe('2026-03-01');
    expect(businessDateOf(toInstant('2026-03-01T21:00:00.000Z'), 'Asia/Riyadh')).toBe('2026-03-02');
  });

  it('handles a year rollover and a leap day', () => {
    expect(businessDateOf(toInstant('2026-12-31T21:00:00.000Z'), 'Asia/Riyadh')).toBe('2027-01-01');
    expect(businessDateOf(toInstant('2028-02-28T21:00:00.000Z'), 'Asia/Riyadh')).toBe('2028-02-29');
  });

  it('agrees with UTC when the store is in UTC', () => {
    expect(businessDateOf(toInstant('2026-03-01T21:30:00.000Z'), 'UTC')).toBe('2026-03-01');
  });

  it('crosses backwards for a western zone', () => {
    expect(businessDateOf(toInstant('2026-03-01T02:00:00.000Z'), 'America/New_York')).toBe('2026-02-28');
  });

  it('throws on an unknown zone, which the engine turns into a rejected result', () => {
    expect(() => businessDateOf(toInstant('2026-03-01T00:00:00.000Z'), 'Mars/Olympus')).toThrow();
  });
});

const order = (over: Partial<CanonicalOrder>): CanonicalOrder =>
  ({
    isTest: false,
    lifecycle: 'open',
    paymentState: 'paid',
    fulfillmentState: 'delivered',
    ...over,
  }) as CanonicalOrder;

describe('computeRecognition', () => {
  it('treats a refused cash-on-delivery parcel as cost-only', () => {
    // The case the whole three-axis status model exists for: no money moved, so
    // there is no refund record, and a one-axis model calls this profitable.
    expect(computeRecognition(order({ paymentState: 'unpaid', fulfillmentState: 'rto' }))).toEqual({
      kind: 'cost_only',
      reason: 'rto_uncollected',
    });
  });

  it('does NOT treat a prepaid return as cost-only — that money really moved', () => {
    expect(computeRecognition(order({ paymentState: 'refunded', fulfillmentState: 'rto' }))).toEqual({
      kind: 'recognized',
    });
  });

  it('separates a cancellation that cost something from one that did not', () => {
    expect(computeRecognition(order({ lifecycle: 'cancelled', paymentState: 'paid' }))).toEqual({
      kind: 'cost_only',
      reason: 'cancelled_after_capture',
    });
    expect(
      computeRecognition(order({ lifecycle: 'cancelled', paymentState: 'unpaid', fulfillmentState: 'in_transit' })),
    ).toEqual({ kind: 'cost_only', reason: 'cancelled_after_dispatch' });
    expect(
      computeRecognition(order({ lifecycle: 'cancelled', paymentState: 'unpaid', fulfillmentState: 'unfulfilled' })),
    ).toEqual({ kind: 'excluded', reason: 'cancelled_before_economic_effect' });
  });

  it('excludes test orders and drafts before anything else', () => {
    expect(computeRecognition(order({ isTest: true, fulfillmentState: 'rto', paymentState: 'unpaid' }))).toEqual({
      kind: 'excluded',
      reason: 'test_order',
    });
    expect(computeRecognition(order({ lifecycle: 'draft' }))).toEqual({ kind: 'excluded', reason: 'draft' });
  });
});

const shipment = (over: Partial<CanonicalShipment>): CanonicalShipment =>
  ({ direction: 'outbound', status: 'delivered', ...over }) as CanonicalShipment;

describe('RTO goods recovery', () => {
  it('credits COGS back only once the return leg has actually arrived', async () => {
    const { rtoGoodsRecovered } = await import('../src/engine/reversal.js');
    expect(rtoGoodsRecovered([shipment({ direction: 'return', status: 'returned_to_origin' })])).toBe(true);
    expect(rtoGoodsRecovered([shipment({ direction: 'return', status: 'in_transit' })])).toBe(false);
    expect(rtoGoodsRecovered([shipment({ direction: 'outbound', status: 'delivered' })])).toBe(false);
    expect(rtoGoodsRecovered([])).toBe(false);
  });
});
