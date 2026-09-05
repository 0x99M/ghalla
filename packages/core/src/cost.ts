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
  /**
   * The merchant's true NET CASH cost per unit — net of recoverable input VAT
   * when the store is VAT-registered, gross when it is not. The same convention
   * `CanonicalShipment.carrierCostMinor` states, and worth restating here
   * because COGS is the largest cost line in the model and the only one a
   * merchant types by hand.
   *
   * Denominated in `StoreProfitConfig.currency` by construction: cost history
   * is per-store, and the caller owns that.
   */
  readonly unitCostMinor: Minor;
  readonly source: CostSource;
  readonly costHistoryId: CostHistoryId;
}
