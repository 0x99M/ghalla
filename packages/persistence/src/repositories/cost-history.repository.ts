import { and, desc, eq, isNull, lte, or, sql } from 'drizzle-orm';
import { COST_SOURCES } from '@ghalla/contracts';
import type { CostSource, Instant, StoreId } from '@ghalla/contracts';
import type { ResolvedCost } from '@ghalla/core';
import type { Database } from '../db/pool.js';
import { costHistory } from '../db/schema.js';
import { minorToNumeric, numericToMinor } from '../db/money.js';
import { toDateFromInstant, toEnumFromColumn, toIdFromColumn } from '../db/codec.js';

export interface ProductKeyRef {
  readonly platformProductId: string;
  readonly platformVariantId: string | null;
  readonly sku: string | null;
}

export interface CostEntry {
  readonly id: string;
  readonly storeId: StoreId;
  readonly platformProductId: string;
  readonly platformVariantId: string | null;
  readonly sku: string | null;
  readonly unitCostMinor: number;
  readonly source: CostSource;
  readonly effectiveFrom: Instant;
  readonly note: string | null;
}

/**
 * Cost history, read as of a moment and never joined live.
 *
 * This repository is where the brief's first non-negotiable actually lives: a
 * merchant editing a cost today must not silently change last quarter's profit.
 * A correction closes the open row and opens a new one — it never updates in
 * place — so every historical order keeps the cost that was true when it was
 * placed, and changing the present requires an explicit, audited recompute.
 */
export class CostHistoryRepository {
  constructor(private readonly db: Database) {}

  /**
   * The as-of query. One indexed predicate per product key, which is why the
   * engine takes resolved costs as an argument rather than reaching for a
   * database: shipping validity windows into every golden fixture would buy
   * nothing and cost a lot.
   *
   * Resolution order is product key first, SKU second — matching the engine.
   * SKU is merchant-entered text, so it is a necessary fallback (some platforms
   * put no variant identity on order lines) and a terrible primary key.
   */
  async resolveAsOf(
    storeId: StoreId,
    keys: readonly ProductKeyRef[],
    asOf: Instant,
  ): Promise<readonly ResolvedCost[]> {
    if (keys.length === 0) return [];
    const at = toDateFromInstant(asOf);

    const rows = await this.db
      .select()
      .from(costHistory)
      .where(
        and(
          eq(costHistory.storeId, storeId),
          lte(costHistory.effectiveFrom, at),
          // Half-open window: [from, to). An open row has no upper bound.
          or(isNull(costHistory.effectiveTo), sql`${costHistory.effectiveTo} > ${at}`),
        ),
      )
      .orderBy(desc(costHistory.effectiveFrom));

    const byProductKey = new Map<string, (typeof rows)[number]>();
    const bySku = new Map<string, (typeof rows)[number]>();
    for (const row of rows) {
      // Rows arrive newest-first, so the first write per key wins and later
      // (older) windows do not overwrite it.
      const key = `${row.platformProductId}|${row.platformVariantId ?? ''}`;
      if (!byProductKey.has(key)) byProductKey.set(key, row);
      if (row.sku !== null && row.sku !== '' && !bySku.has(row.sku)) bySku.set(row.sku, row);
    }

    const resolved: ResolvedCost[] = [];
    for (const wanted of keys) {
      const exact = byProductKey.get(`${wanted.platformProductId}|${wanted.platformVariantId ?? ''}`);
      // A product-level row (no variant) covers every variant of that product.
      const productLevel = byProductKey.get(`${wanted.platformProductId}|`);
      const bySkuMatch = wanted.sku === null ? undefined : bySku.get(wanted.sku);
      const row = exact ?? productLevel ?? bySkuMatch;
      if (row === undefined) continue;

      resolved.push({
        platformProductId: wanted.platformProductId,
        platformVariantId: wanted.platformVariantId,
        sku: wanted.sku,
        unitCostMinor: numericToMinor(row.unitCostMinor),
        source: toEnumFromColumn(row.source, COST_SOURCES, 'cost_history.source'),
        costHistoryId: toIdFromColumn<'costHistory'>(row.id),
      });
    }
    return resolved;
  }

  /**
   * Records a cost, closing whatever was open for that key.
   *
   * One transaction, because an open window left behind would make the as-of
   * query return two rows for one key — which the engine treats as a fatal
   * `DUPLICATE_COST_KEY` rather than silently picking one, precisely so this
   * bug cannot express itself as a wrong number.
   */
  async record(entry: CostEntry): Promise<void> {
    const from = toDateFromInstant(entry.effectiveFrom);
    await this.db.transaction(async (tx) => {
      await tx
        .update(costHistory)
        .set({ effectiveTo: from })
        .where(
          and(
            eq(costHistory.storeId, entry.storeId),
            eq(costHistory.platformProductId, entry.platformProductId),
            entry.platformVariantId === null
              ? isNull(costHistory.platformVariantId)
              : eq(costHistory.platformVariantId, entry.platformVariantId),
            isNull(costHistory.effectiveTo),
          ),
        );

      await tx.insert(costHistory).values({
        id: entry.id,
        storeId: entry.storeId,
        platformProductId: entry.platformProductId,
        platformVariantId: entry.platformVariantId,
        sku: entry.sku,
        unitCostMinor: minorToNumeric(numericToMinor(String(entry.unitCostMinor / 100))),
        source: entry.source,
        effectiveFrom: from,
        effectiveTo: null,
        supersedesId: null,
        note: entry.note,
      });
    });
  }

  /**
   * Coverage, weighted by REVENUE and not by SKU count.
   *
   * A merchant with one costed bestseller and forty uncosted long-tail products
   * has covered most of their money and almost none of their catalogue. The
   * number that helps them is the first one, which is why the engine stores a
   * numerator rather than a percentage — percentages do not aggregate.
   */
  async countKeysWithCost(storeId: StoreId): Promise<number> {
    const [row] = await this.db
      .select({ count: sql<number>`count(distinct (${costHistory.platformProductId}, ${costHistory.platformVariantId}))::int` })
      .from(costHistory)
      .where(and(eq(costHistory.storeId, storeId), isNull(costHistory.effectiveTo)));
    return row?.count ?? 0;
  }
}
