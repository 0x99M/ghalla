import { describe, expect, it } from 'vitest';
import {
  AttributionSchema,
  BpsSchema,
  CurrencyCodeSchema,
  CustomerRefSchema,
  InstantSchema,
  LocalDateSchema,
  MinorSchema,
  PlatformIdSchema,
  QuantitySchema,
  RateBpsSchema,
  RawLabelSchema,
  SlugSchema,
  idSchema,
} from '../src/index.js';

/**
 * The ingestion edge, one primitive at a time.
 *
 * Every one of these refinements is invisible to the drift audit — `z.infer`
 * erases a `.refine`, so deleting one leaves tsc, eslint and the audit all
 * green while the invariant it carried silently stops being enforced. These
 * tests are the only thing standing under them.
 */
const accepts = (schema: { safeParse: (v: unknown) => { success: boolean } }, value: unknown): boolean =>
  schema.safeParse(value).success;

describe('MinorSchema', () => {
  it('returns the same integer it was given, never a scaled one', () => {
    // The schema validates money; it does not convert it. A schema that quietly
    // multiplied by 100 would make the adapter's own conversion invisible.
    expect(MinorSchema.parse(60_000)).toBe(60_000);
    expect(MinorSchema.parse(-1)).toBe(-1);
  });

  it('rejects an amount that arrived in major units', () => {
    // SAR 15.99 rather than 1599 halalas. `z.int()` catches it here, at the one
    // boundary where the platform's own convention is still known.
    expect(accepts(MinorSchema, 15.99)).toBe(false);
  });
});

describe('BpsSchema', () => {
  it('accepts a negative rate, because a margin in basis points is signed', () => {
    // `Bps` is a scale, not a range: a return to origin puts marginBps far below
    // -10 000, and a schema that bounded it would reject the worst orders in the
    // catalogue — the ones the merchant most needs to see.
    expect(accepts(BpsSchema, -125_000)).toBe(true);
    expect(BpsSchema.parse(275)).toBe(275);
  });

  it('rejects a rate typed as 2.75 instead of 275', () => {
    // The percent-for-basis-points slip is a hundredfold error, and 2.75 is a
    // number a merchant would type into a fee form without blinking.
    expect(accepts(BpsSchema, 2.75)).toBe(false);
  });
});

describe('RateBpsSchema', () => {
  it('admits both ends of the range a rate can occupy', () => {
    // Zero is a real VAT rate for an unregistered store, and 100% is the ceiling
    // rather than an impossibility.
    expect(accepts(RateBpsSchema, 0)).toBe(true);
    expect(accepts(RateBpsSchema, 10_000)).toBe(true);
  });

  it('rejects a negative rate, which would make net exceed gross', () => {
    // VAT extraction with a negative rate returns a net larger than the gross,
    // overstating revenue on every order for that store, from one bad ingest.
    expect(accepts(RateBpsSchema, -1)).toBe(false);
  });
});

describe('InstantSchema', () => {
  it('accepts the canonical UTC form and nothing shorter', () => {
    expect(InstantSchema.parse('2026-03-01T18:30:00.000Z')).toBe('2026-03-01T18:30:00.000Z');
    // Milliseconds are not optional: two webhook deliveries in the same second
    // have to keep their order.
    expect(accepts(InstantSchema, '2026-03-01T18:30:00Z')).toBe(false);
  });

  it('rejects an offset form rather than normalizing it', () => {
    // Accepting +03:00 would mean every comparison in the system has to remember
    // to normalize first, and the one that forgets is a silent three-hour error
    // in a country that is UTC+3.
    expect(accepts(InstantSchema, '2026-03-01T21:30:00.000+03:00')).toBe(false);
  });

  it('rejects a time of day that does not exist', () => {
    expect(accepts(InstantSchema, '2026-03-01T24:00:00.000Z')).toBe(false);
    expect(accepts(InstantSchema, '2026-03-01T18:60:00.000Z')).toBe(false);
  });
});

describe('LocalDateSchema', () => {
  it('accepts a business date in the store-local calendar', () => {
    expect(LocalDateSchema.parse('2026-03-01')).toBe('2026-03-01');
    expect(accepts(LocalDateSchema, '2024-02-29')).toBe(true);
  });

  it('rejects a date that never happened', () => {
    // Checked arithmetically rather than by constructing a Date, which would
    // roll 2026-02-30 forward into March and move the order a day.
    expect(accepts(LocalDateSchema, '2026-02-30')).toBe(false);
    expect(accepts(LocalDateSchema, '2026-02-29')).toBe(false);
  });

  it('rejects an instant handed to it in place of a business date', () => {
    // One is UTC, the other is store-local. Bucketing an order by the wrong one
    // moves every Riyadh evening order into the next day.
    expect(accepts(LocalDateSchema, '2026-03-01T18:30:00.000Z')).toBe(false);
  });
});

describe('CurrencyCodeSchema', () => {
  it('accepts the codes the domain knows, including the ones storage cannot hold', () => {
    // KWD is a valid currency and an unstorable one. The domain says so here;
    // the persistence layer refuses it separately, and loudly.
    expect(accepts(CurrencyCodeSchema, 'SAR')).toBe(true);
    expect(accepts(CurrencyCodeSchema, 'KWD')).toBe(true);
  });

  it('rejects anything outside the list, however plausible', () => {
    expect(accepts(CurrencyCodeSchema, 'sar')).toBe(false);
    expect(accepts(CurrencyCodeSchema, 'EUR')).toBe(false);
  });
});

describe('idSchema', () => {
  it('rehydrates an id the adapter already derived', () => {
    expect(idSchema<'order'>().parse('demo:1:1001')).toBe('demo:1:1001');
  });

  it('rejects an empty id, which would match every row or none', () => {
    expect(accepts(idSchema<'order'>(), '')).toBe(false);
  });
});

describe('CustomerRefSchema', () => {
  const digest = 'a'.repeat(64);

  it('accepts a 64-character lowercase hex digest', () => {
    expect(CustomerRefSchema.parse(digest)).toBe(digest);
  });

  it('rejects a platform customer id, which is the thing it exists to replace', () => {
    // Platform customer ids are small sequential integers. One stored here would
    // be reversible from a database dump in seconds, which is the single
    // property this field exists to lack.
    expect(accepts(CustomerRefSchema, '12345')).toBe(false);
    expect(accepts(CustomerRefSchema, 'A'.repeat(64))).toBe(false);
    expect(accepts(CustomerRefSchema, 'a'.repeat(63))).toBe(false);
  });
});

describe('PlatformIdSchema', () => {
  it('accepts the adapter’s own slug without checking it against a list', () => {
    // A union of known platforms here would put platform vocabulary in the
    // shared layer, which is the one thing this architecture exists to prevent.
    expect(PlatformIdSchema.parse('demo_platform')).toBe('demo_platform');
    expect(accepts(PlatformIdSchema, 'some_new_platform')).toBe(true);
  });

  it('rejects a slug that is not one', () => {
    expect(accepts(PlatformIdSchema, 'Demo_Platform')).toBe(false);
    expect(accepts(PlatformIdSchema, '')).toBe(false);
    expect(accepts(PlatformIdSchema, '_leading')).toBe(false);
  });
});

describe('SlugSchema', () => {
  it('accepts an adapter-normalized carrier or wallet', () => {
    expect(accepts(SlugSchema, 'aramex')).toBe(true);
    expect(accepts(SlugSchema, 'apple_pay')).toBe(true);
    expect(accepts(SlugSchema, 'smsa-express')).toBe(true);
  });

  it('rejects the platform’s raw label, which belongs in rawCarrierLabel', () => {
    // Normalizing is the adapter's job. A display string used as a key means
    // "SMSA Express" and "smsa express" become two carriers with two fee rules.
    expect(accepts(SlugSchema, 'SMSA Express')).toBe(false);
    expect(accepts(SlugSchema, 'a'.repeat(65))).toBe(false);
  });
});

describe('RawLabelSchema', () => {
  it('accepts an Arabic label rather than guessing at PII', () => {
    // The cap is deliberately a length limit and not a name-or-phone pattern: a
    // pattern would reject legitimate Arabic labels and fail ingestion for a
    // whole store. Adapters must map these from enumerated fields instead.
    expect(accepts(RawLabelSchema, 'تم التوصيل')).toBe(true);
    expect(accepts(RawLabelSchema, '')).toBe(true);
  });
});

describe('QuantitySchema', () => {
  it('accepts zero, which a fully reversed line reports', () => {
    expect(accepts(QuantitySchema, 0)).toBe(true);
  });

  it('rejects a measured or negative quantity', () => {
    // Quantities are counted, never measured, in phase one. A fractional one
    // means a weight-priced line the allocator has no way to split.
    expect(accepts(QuantitySchema, 1.5)).toBe(false);
    expect(accepts(QuantitySchema, -1)).toBe(false);
  });
});

describe('attribution referrer host', () => {
  const attribution = { device: 'mobile', referrerHost: 'google.com' };

  it('accepts a bare host', () => {
    expect(accepts(AttributionSchema, attribution)).toBe(true);
  });

  it('accepts no referrer at all, which is the ordinary case', () => {
    expect(accepts(AttributionSchema, { ...attribution, referrerHost: null })).toBe(true);
  });

  it('rejects a path, because a search path carries what the customer typed', () => {
    expect(accepts(AttributionSchema, { ...attribution, referrerHost: 'google.com/search' })).toBe(false);
  });

  it('rejects a query string, which is where the identifiers live', () => {
    // Stripping is the adapter's job; this is the backstop that turns a mapper
    // passing the raw referrer through into a failed ingest rather than a row of
    // search terms and click ids sitting in the database.
    expect(accepts(AttributionSchema, { ...attribution, referrerHost: 'google.com?q=someones+name' })).toBe(
      false,
    );
  });
});
