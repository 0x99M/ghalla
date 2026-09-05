import type { CostHistoryId, CostSource, Minor } from '@ghalla/contracts';

/**
 * A unit cost, already resolved as of the order's placement time by the caller.
 *
 * The as-of query against the slowly-changing cost history is one indexed SQL
 * predicate and belongs in persistence. Pushing validity windows into the engine
 * would put a date comparison in every golden fixture for no benefit — but the
 * *join* to lines, and detection of a miss, stay here where the diagnostics are.
 *
 * The point of resolving once, at ingestion, is that a merchant correcting a
 * cost today must not silently change last quarter's profit. A correction is an
 * explicit, audited recompute.
 */
export interface ResolvedCost {
  readonly platformProductId: string;
  readonly platformVariantId: string | null;
  /** Secondary resolution key, necessary where order lines carry no variant identity. */
  readonly sku: string | null;
  readonly unitCostMinor: Minor;
  readonly source: CostSource;
  readonly costHistoryId: CostHistoryId;
}
