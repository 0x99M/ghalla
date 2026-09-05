import { z } from 'zod';
import {
  CURRENCY_CODES,
  MAX_MINOR,
  idFromString,
  isBps,
  isCustomerRef,
  isInstant,
  isLocalDate,
  isMinor,
  isPlatformId,
  toBps,
  toCustomerRef,
  toInstant,
  toLocalDate,
  toMinor,
  toPlatformId,
} from '@ghalla/contracts';
import type { Bps, CustomerRef, Id, Instant, LocalDate, Minor, PlatformId } from '@ghalla/contracts';

/**
 * Every schema below is annotated with `z.ZodType<Output, Input>` rather than
 * letting zod's inference speak.
 *
 * That is not style. The brand in `@ghalla/contracts` is keyed by a
 * module-private `unique symbol`, which TypeScript cannot name across a package
 * boundary — so an inferred export whose type *expands* to the brand fails
 * declaration emit with TS4023. Naming the alias fixes it without weakening the
 * brand, and it documents each schema's contract at the same time: what goes in,
 * what comes out.
 */

/**
 * Money never arrives as a float and never leaves as one.
 *
 * `z.int()` rejects `1.5` and `"1500"` alike, so a platform amount that skipped
 * the adapter's conversion fails at the edge instead of becoming a plausible
 * wrong number. There is no `as` anywhere here: once the refinement passes,
 * `toMinor` cannot throw, so the branded value comes from the same checked
 * constructor everything else uses.
 */
export const MinorSchema: z.ZodType<Minor, number> = z
  .int()
  .refine(isMinor, { error: `Money must be an integer count of minor units within ±${String(MAX_MINOR)}.` })
  .transform(toMinor);

export const BpsSchema: z.ZodType<Bps, number> = z.int().refine(isBps).transform(toBps);

/**
 * A RATE in basis points: 0% to 100%.
 *
 * `Bps` itself is deliberately unbounded, because it is a scale rather than a
 * range — `OrderProfitTotals.marginBps` is legitimately negative and can fall
 * far below -10 000 on a return to origin. But a VAT rate is not a margin, and
 * an unbounded one is not harmless: a negative `vatRateBps` makes VAT
 * extraction return a net larger than the gross, overstating revenue on every
 * order for that store, forever, from a single bad ingestion.
 */
export const RateBpsSchema: z.ZodType<Bps, number> = BpsSchema.refine(
  (b) => b >= 0 && b <= 10_000,
  { error: 'A rate in basis points must be between 0 (0%) and 10000 (100%).' },
);

export const InstantSchema: z.ZodType<Instant, string> = z
  .string()
  .refine(isInstant, { error: 'Expected an ISO-8601 UTC instant: YYYY-MM-DDTHH:mm:ss.sssZ.' })
  .transform(toInstant);

export const LocalDateSchema: z.ZodType<LocalDate, string> = z
  .string()
  .refine(isLocalDate, { error: 'Expected a calendar date: YYYY-MM-DD.' })
  .transform(toLocalDate);

export const CurrencyCodeSchema = z.enum(CURRENCY_CODES);

/** Rehydrates a typed id. Its shape was validated when the adapter derived it. */
export const idSchema = <T extends string>(): z.ZodType<Id<T>, string> =>
  z.string().min(1).transform<Id<T>>(idFromString<T>);

export const CustomerRefSchema: z.ZodType<CustomerRef, string> = z
  .string()
  .refine(isCustomerRef, { error: 'A customer reference must be a 64-character lowercase hex digest.' })
  .transform(toCustomerRef);

/** The adapter's own slug. Never validated against a list of known platforms — that list would be the
 *  platform vocabulary this architecture exists to keep out of the shared layer. */
export const PlatformIdSchema: z.ZodType<PlatformId, string> = z
  .string()
  .refine(isPlatformId, { error: 'A platform id must be a lowercase slug.' })
  .transform(toPlatformId);

/** Adapter-normalized open slug: carrier, payment processor, wallet. */
export const SlugSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);

/**
 * A platform's verbatim label, kept for triage.
 *
 * Capped, because these are the model's only free-text fields and
 * `AssertNoPii` guards KEYS, not VALUES — it cannot see a customer's name that
 * a merchant typed into a refund reason. The cap is a backstop, not the
 * control: adapters must map these from enumerated platform fields and never
 * pass through customer-entered text. A length limit is deliberately preferred
 * to a name-or-phone pattern, which would reject legitimate Arabic labels and
 * fail ingestion for a whole store.
 */
export const RawLabelSchema = z.string().max(120);

/** Quantities are counted, never measured, in phase one. */
export const QuantitySchema = z.int().nonnegative();
