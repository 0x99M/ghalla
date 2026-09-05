import { describe, expect, it } from 'vitest';
import {
  CARD_SCHEMES,
  COST_SOURCES,
  DEVICES,
  EXACT_COST_SOURCES,
  FULFILLMENT_METHODS,
  FULFILLMENT_STATES,
  ORDER_LIFECYCLES,
  PAYMENT_INSTRUMENTS,
  PAYMENT_LEG_STATES,
  PAYMENT_STATES,
  RESTOCK_OUTCOMES,
  REVERSAL_KINDS,
  REVERSAL_REASONS,
  SHIPMENT_DIRECTIONS,
  SHIPMENT_STATUSES,
} from '../src/enums.js';

/**
 * Each tuple is read three times over: by `z.enum()` in the schemas package, by
 * the `IN (...)` CHECK constraints the persistence schema generates from it, and
 * by every adapter's normalization table. A member added or dropped here
 * therefore moves all three at once — and the database is the one that fails in
 * production rather than in CI, because a row written under the old vocabulary
 * is still sitting in the table.
 *
 * So the membership is pinned rather than inspected. A deliberate change edits
 * this list and reads as a two-line diff; an accidental one does not compile
 * past here.
 */
const VOCABULARIES: [string, readonly string[], string[]][] = [
  ['ORDER_LIFECYCLES', ORDER_LIFECYCLES, ['draft', 'open', 'completed', 'cancelled']],
  [
    'PAYMENT_STATES',
    PAYMENT_STATES,
    ['unpaid', 'authorized', 'paid', 'partially_refunded', 'refunded', 'voided', 'failed'],
  ],
  [
    'FULFILLMENT_STATES',
    FULFILLMENT_STATES,
    ['unfulfilled', 'partially_fulfilled', 'in_transit', 'delivered', 'returned', 'rto', 'not_applicable'],
  ],
  ['FULFILLMENT_METHODS', FULFILLMENT_METHODS, ['carrier', 'pickup', 'self_delivery', 'digital', 'other']],
  [
    'PAYMENT_INSTRUMENTS',
    PAYMENT_INSTRUMENTS,
    ['card', 'bnpl', 'wallet', 'cod', 'bank_transfer', 'free', 'unknown', 'other'],
  ],
  ['CARD_SCHEMES', CARD_SCHEMES, ['mada', 'visa', 'mastercard', 'amex', 'unionpay', 'other', 'unknown']],
  ['PAYMENT_LEG_STATES', PAYMENT_LEG_STATES, ['pending', 'authorized', 'captured', 'failed', 'refunded']],
  ['SHIPMENT_DIRECTIONS', SHIPMENT_DIRECTIONS, ['outbound', 'return']],
  [
    'SHIPMENT_STATUSES',
    SHIPMENT_STATUSES,
    [
      'created',
      'in_transit',
      'out_for_delivery',
      'delivered',
      'failed_attempt',
      'returned_to_origin',
      'cancelled',
      'lost',
      'unknown',
    ],
  ],
  ['REVERSAL_KINDS', REVERSAL_KINDS, ['refund', 'void', 'chargeback']],
  [
    'REVERSAL_REASONS',
    REVERSAL_REASONS,
    [
      'customer_return',
      'damaged_or_defective',
      'wrong_item',
      'cancelled_before_dispatch',
      'goodwill_or_price_adjustment',
      'chargeback',
      'other',
      'unknown',
    ],
  ],
  [
    'RESTOCK_OUTCOMES',
    RESTOCK_OUTCOMES,
    [
      'restocked_sellable',
      'restocked_damaged',
      'not_restocked',
      'pending_receipt',
      'not_applicable',
      'unknown',
    ],
  ],
  [
    'COST_SOURCES',
    COST_SOURCES,
    ['merchant_manual', 'merchant_bulk_import', 'platform', 'category_default', 'none'],
  ],
  ['DEVICES', DEVICES, ['desktop', 'mobile', 'tablet', 'unknown']],
];

describe('the closed vocabularies', () => {
  it.each(VOCABULARIES)('%s holds exactly the members its three consumers were built against', (_name, actual, expected) => {
    expect(actual).toEqual(expected);
  });

  it.each(VOCABULARIES)('%s repeats no member', (_name, actual) => {
    // An adapter's normalization table is keyed on these strings, so a repeated
    // member is a lookup whose second entry can never be reached — and whichever
    // mapping lost is the one nobody will think to check.
    expect(new Set(actual).size).toBe(actual.length);
  });

  it.each(VOCABULARIES)('%s uses slugs that survive being pasted into a generated CHECK constraint', (_name, actual) => {
    // The persistence schema builds `IN ('a', 'b')` by string-joining these
    // values with `sql.raw`. That is only safe while every member is a bare
    // lowercase slug: a quote or a space would produce a migration that either
    // fails to apply or applies with the wrong set.
    for (const member of actual) {
      expect(member).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });
});

describe('the escape hatches', () => {
  it.each<[string, string, readonly string[]]>([
    ['CARD_SCHEMES', 'unknown', CARD_SCHEMES],
    ['CARD_SCHEMES', 'other', CARD_SCHEMES],
    ['PAYMENT_INSTRUMENTS', 'unknown', PAYMENT_INSTRUMENTS],
    ['PAYMENT_INSTRUMENTS', 'other', PAYMENT_INSTRUMENTS],
    ['SHIPMENT_STATUSES', 'unknown', SHIPMENT_STATUSES],
    ['REVERSAL_REASONS', 'unknown', REVERSAL_REASONS],
    ['REVERSAL_REASONS', 'other', REVERSAL_REASONS],
    ['RESTOCK_OUTCOMES', 'unknown', RESTOCK_OUTCOMES],
    ['RESTOCK_OUTCOMES', 'pending_receipt', RESTOCK_OUTCOMES],
    ['DEVICES', 'unknown', DEVICES],
    ['FULFILLMENT_METHODS', 'other', FULFILLMENT_METHODS],
    ['FULFILLMENT_STATES', 'not_applicable', FULFILLMENT_STATES],
  ])('%s keeps its %s member, so an adapter meeting a value it does not recognise never has to guess', (_name, member, members) => {
    // Removing one of these does not produce a validation error at the boundary;
    // it produces a *plausible* value, chosen by an adapter with nothing better
    // to fall back on. On a card scheme that is roughly a 3x fee error, and the
    // discarded axis is not recoverable from the stored row afterwards.
    expect(members).toContain(member);
  });
});

describe('the members that carry a decision', () => {
  it('separates a return to origin from a return, because only one of them ever collected money', () => {
    // A refused cash-on-delivery parcel produces no refund record anywhere. Fold
    // `rto` into `returned` and the most common Saudi loss shape — two shipping
    // legs and no revenue — reports as a fully profitable order.
    expect(FULFILLMENT_STATES).toContain('rto');
    expect(FULFILLMENT_STATES).toContain('returned');
  });

  it('keeps the leg-level captured apart from the order-level paid, so an uncaptured leg accrues no gateway fee', () => {
    // This is also the whole mechanism by which a void costs nothing: the fee is
    // charged against a leg in state `captured`, not against an order marked paid.
    expect(PAYMENT_LEG_STATES).toContain('captured');
    expect(PAYMENT_LEG_STATES).not.toContain('paid');
    expect(PAYMENT_STATES).not.toContain('captured');
  });

  it('keeps the card network on its own axis, where it can price differently from the rail that carried it', () => {
    // The domestic debit network prices nothing like an international credit
    // card, so a scheme is not a peer of a rail. The only vocabulary the two
    // lists are allowed to share is the pair of escape hatches.
    const shared = CARD_SCHEMES.filter((scheme) => (PAYMENT_INSTRUMENTS as readonly string[]).includes(scheme));
    expect(shared).toEqual(['other', 'unknown']);
    expect(CARD_SCHEMES).toContain('mada');
  });

  it('gives a restock outcome a value for goods that have not arrived back yet', () => {
    // At the moment a refund is issued the goods are usually still in transit.
    // A boolean would default to false there and permanently understate margin.
    expect(RESTOCK_OUTCOMES).toContain('pending_receipt');
  });

  it('distinguishes a cost nobody supplied from a cost we guessed at', () => {
    // A missing cost contributes zero to COGS, which reports an uncosted SKU as
    // the most profitable item in the catalogue. `none` is what lets the
    // confidence level say `incomplete` instead of `estimated`.
    expect(COST_SOURCES).toContain('none');
    expect(COST_SOURCES).toContain('category_default');
  });
});

describe('EXACT_COST_SOURCES', () => {
  it('names only sources that exist in COST_SOURCES', () => {
    // It is a filter over that list, not a second list. A member that has
    // drifted out of COST_SOURCES matches nothing and silently stops counting.
    for (const source of EXACT_COST_SOURCES) {
      expect(COST_SOURCES).toContain(source);
    }
  });

  it('counts a cost somebody supplied and nothing else toward the coverage indicator', () => {
    // The indicator tells a merchant what fraction of their revenue has real
    // cost data behind it. Admit `category_default` and it reports complete
    // coverage over a catalogue where every number is our guess.
    expect(EXACT_COST_SOURCES).toEqual(['merchant_manual', 'merchant_bulk_import', 'platform']);

    const estimated = COST_SOURCES.filter((source) => !EXACT_COST_SOURCES.includes(source));
    expect(estimated).toEqual(['category_default', 'none']);
  });
});
