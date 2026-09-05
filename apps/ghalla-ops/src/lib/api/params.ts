import { z } from 'zod';
import { RANGES } from '../queries/window';
import { STORE_SORTS } from '../queries/stores';
import type { Range } from '../queries/window';
import type { StoreFilter, StoreSort } from '../queries/stores';

/**
 * Every query parameter the API accepts, parsed in ONE place.
 *
 * Route handlers hold no logic — that is the rule the coverage exclusion for
 * `src/app/**` rests on — so the parsing lives here, where it is a table test
 * rather than something exercised by curl.
 *
 * Everything is closed rather than free-form: a sort is one of four names, a
 * range one of four windows, a cursor a non-negative integer. Not because a
 * parameterised query is injectable — it is not — but because an unbounded
 * `limit` or an unrecognised `sort` reaching a query is how an internal tool
 * accidentally becomes a way to ask an integration's database for everything.
 */

/**
 * A string parameter turned into `undefined` when absent OR blank.
 *
 * `?status=` is what a UI sends when its filter is cleared, and treating that
 * as a filter for the empty status would return nothing and look like a bug in
 * the data.
 */
const optionalText = z
  .string()
  .trim()
  .transform((value) => (value === '' ? undefined : value))
  .optional();

/**
 * `true` only for the literal string. `z.coerce.boolean()` is wrong here:
 * `Boolean('false')` is `true`, so a filter explicitly turned off would turn
 * itself back on.
 */
const flag = z
  .enum(['true', 'false'])
  .optional()
  .transform((value) => value === 'true');

export const rangeSchema = z.enum([...RANGES]).default('7d');

export const storeQuerySchema = z.object({
  platform: optionalText,
  status: optionalText,
  plan: optionalText,
  needsAttention: flag,
  sort: z.enum([...STORE_SORTS]).default('orders'),
  cursor: z.coerce.number().int().min(0).default(0),
  // Capped. An operator page shows a page; a request for fifty thousand rows is
  // either a mistake or a way to make the portal hold a connection for a minute.
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export interface StoreQuery {
  readonly filter: StoreFilter;
  readonly sort: StoreSort;
  readonly cursor: number;
  readonly limit: number;
}

export type Parsed<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly issues: readonly string[] };

function toIssues(error: z.ZodError): readonly string[] {
  return error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`);
}

/** URLSearchParams to a plain object, keeping only the first value of a repeated key. */
export function toRecord(params: URLSearchParams): Record<string, string> {
  const record: Record<string, string> = {};
  for (const [key, value] of params) record[key] ??= value;
  return record;
}

export function parseRange(params: URLSearchParams): Parsed<Range> {
  const result = rangeSchema.safeParse(toRecord(params)['range']);
  return result.success ? { ok: true, value: result.data } : { ok: false, issues: toIssues(result.error) };
}

export function parseStoreQuery(params: URLSearchParams): Parsed<StoreQuery> {
  const result = storeQuerySchema.safeParse(toRecord(params));
  if (!result.success) return { ok: false, issues: toIssues(result.error) };

  const { platform, status, plan, needsAttention, sort, cursor, limit } = result.data;
  return {
    ok: true,
    value: { filter: { platform, status, plan, needsAttention }, sort, cursor, limit },
  };
}

/** An alert key from the path. Bounded, because it is written into the portal's database. */
export const alertKeySchema = z.string().trim().min(1).max(256);

export const ackBodySchema = z.object({
  note: z.string().trim().max(1000).optional(),
});

export function parseAckBody(body: unknown): Parsed<{ note?: string | undefined }> {
  const result = ackBodySchema.safeParse(body ?? {});
  return result.success ? { ok: true, value: result.data } : { ok: false, issues: toIssues(result.error) };
}

export function parseAlertKey(raw: string): Parsed<string> {
  const result = alertKeySchema.safeParse(decodeURIComponent(raw));
  return result.success ? { ok: true, value: result.data } : { ok: false, issues: toIssues(result.error) };
}
