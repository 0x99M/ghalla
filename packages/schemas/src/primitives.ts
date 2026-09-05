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

/** Quantities are counted, never measured, in phase one. */
export const QuantitySchema = z.int().nonnegative();
