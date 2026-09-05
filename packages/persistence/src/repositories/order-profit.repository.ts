import { and, eq, lt } from 'drizzle-orm';
import type { LocalDate, StoreId } from '@ghalla/contracts';
import type { OrderProfitLine, OrderProfitResult } from '@ghalla/core';
import type { Database } from '../db/pool.js';
import { dailyStoreRollup, dailyVariantRollup, orderProfit, orderProfitLines } from '../db/schema.js';
import { minorToNumeric } from '../db/money.js';

/**
 * Materializes a profit result and marks what it invalidated.
 *
 * The write and the dirty flags are ONE transaction on purpose. A result stored
 * without its buckets marked is a rollup that is silently stale — and because
 * the sweep only looks at dirty rows, nothing would ever notice. Marking
 * without storing is merely wasted work, which is the survivable direction, but
 * there is no reason to allow either.
 */
export class OrderProfitRepository {
  constructor(private readonly db: Database) {}

  async save(result: OrderProfitResult): Promise<void> {
    await this.db.transaction(async (tx) => {
      if (result.status === 'rejected') {
        // A rejected order still needs a row: without one, a dead-lettered order
        // is indistinguishable from an order nobody has computed yet, and the
        // recompute sweep would pick it up forever.
        //
        // Every money column is CLEARED, not left behind. An order that computed
        // once and now rejects would otherwise keep its totals beside
        // `status: 'rejected'`, which `order_profit_totals_iff_computed` refuses
        // — so the whole transaction rolled back and the dead-letter was never
        // recorded at all. The currency and business date go too: the engine
        // rejected before it knew either.
        const cleared = {
          currency: null,
          businessDate: null,
          recognitionKind: 'excluded',
          recognitionReason: null,
          feeRuleSetId: null,
          itemsRevenueExVatMinor: null,
          shippingRevenueExVatMinor: null,
          codFeeRevenueExVatMinor: null,
          orderDiscountExVatMinor: null,
          revenueExVatMinor: null,
          vatCollectedMinor: null,
          cogsMinor: null,
          outboundShippingCostMinor: null,
          returnShippingCostMinor: null,
          gatewayFeeExVatMinor: null,
          gatewayFeeVatMinor: null,
          gatewayFeeCostMinor: null,
          codCostExVatMinor: null,
          codCostVatMinor: null,
          codCostMinor: null,
          reversedRevenueExVatMinor: null,
          restockedCogsMinor: null,
          reversalImpactMinor: null,
          contributionMarginMinor: null,
          marginBps: null,
          costCoveredRevenueExVatMinor: null,
          confidence: null,
        } as const;

        // Whatever bucket the previous computation contributed to has to be
        // rebuilt without it.
        const [previous] = await tx
          .select({ businessDate: orderProfit.businessDate })
          .from(orderProfit)
          .where(eq(orderProfit.orderId, result.orderId));

        await tx
          .insert(orderProfit)
          .values({
            orderId: result.orderId,
            storeId: result.storeId,
            calcVersion: result.calcVersion,
            status: 'rejected',
            diagnostics: result.diagnostics,
            ...cleared,
          })
          .onConflictDoUpdate({
            target: orderProfit.orderId,
            set: {
              calcVersion: result.calcVersion,
              status: 'rejected',
              diagnostics: result.diagnostics,
              computedAt: new Date(),
              ...cleared,
            },
          });
        await tx.delete(orderProfitLines).where(eq(orderProfitLines.orderId, result.orderId));

        if (previous?.businessDate != null) {
          const now = new Date();
          await tx
            .insert(dailyStoreRollup)
            .values({ storeId: result.storeId, businessDate: previous.businessDate, dirty: true, dirtiedAt: now })
            .onConflictDoUpdate({
              target: [dailyStoreRollup.storeId, dailyStoreRollup.businessDate],
              set: { dirty: true, dirtiedAt: now },
            });
        }
        return;
      }

      const t = result.totals;
      const row = {
        orderId: result.orderId,
        storeId: result.storeId,
        calcVersion: result.calcVersion,
        feeRuleSetId: result.feeRuleSetId,
        currency: result.currency,
        businessDate: result.businessDate,
        status: 'computed' as const,
        recognitionKind: result.recognition.kind,
        recognitionReason: 'reason' in result.recognition ? result.recognition.reason : null,

        itemsRevenueExVatMinor: minorToNumeric(t.itemsRevenueExVatMinor),
        shippingRevenueExVatMinor: minorToNumeric(t.shippingRevenueExVatMinor),
        codFeeRevenueExVatMinor: minorToNumeric(t.codFeeRevenueExVatMinor),
        orderDiscountExVatMinor: minorToNumeric(t.orderDiscountExVatMinor),
        revenueExVatMinor: minorToNumeric(t.revenueExVatMinor),
        vatCollectedMinor: minorToNumeric(t.vatCollectedMinor),
        cogsMinor: minorToNumeric(t.cogsMinor),
        outboundShippingCostMinor: minorToNumeric(t.outboundShippingCostMinor),
        returnShippingCostMinor: minorToNumeric(t.returnShippingCostMinor),
        gatewayFeeExVatMinor: minorToNumeric(t.gatewayFeeExVatMinor),
        gatewayFeeVatMinor: minorToNumeric(t.gatewayFeeVatMinor),
        gatewayFeeCostMinor: minorToNumeric(t.gatewayFeeCostMinor),
        codCostExVatMinor: minorToNumeric(t.codCostExVatMinor),
        codCostVatMinor: minorToNumeric(t.codCostVatMinor),
        codCostMinor: minorToNumeric(t.codCostMinor),
        reversedRevenueExVatMinor: minorToNumeric(t.reversedRevenueExVatMinor),
        restockedCogsMinor: minorToNumeric(t.restockedCogsMinor),
        reversalImpactMinor: minorToNumeric(t.reversalImpactMinor),
        contributionMarginMinor: minorToNumeric(t.contributionMarginMinor),
        marginBps: t.marginBps,
        costCoveredRevenueExVatMinor: minorToNumeric(t.costCoveredRevenueExVatMinor),

        confidence: result.confidence,
        diagnostics: result.diagnostics,
        computedAt: new Date(),
      };

      const { orderId: _ignored, ...updatable } = row;
      await tx.insert(orderProfit).values(row).onConflictDoUpdate({
        target: orderProfit.orderId,
        set: updatable,
      });

      // Replace rather than upsert: a recompute can produce FEWER lines than the
      // previous run — an item removed from an order, or a calc version that
      // stopped emitting one — and an upsert would leave the extra rows behind
      // to be summed into the rollup forever.
      await tx.delete(orderProfitLines).where(eq(orderProfitLines.orderId, result.orderId));
      if (result.lines.length > 0) {
        await tx.insert(orderProfitLines).values(
          result.lines.map((line) => ({
            orderId: result.orderId,
            orderItemId: line.orderItemId,
            storeId: result.storeId,
            businessDate: result.businessDate,
            platformProductId: line.platformProductId,
            platformVariantId: line.platformVariantId,
            sku: line.sku,
            quantity: line.quantity,
            allocatedOrderDiscountExVatMinor: minorToNumeric(line.allocatedOrderDiscountExVatMinor),
            netRevenueExVatMinor: minorToNumeric(line.netRevenueExVatMinor),
            allocatedShippingRevenueExVatMinor: minorToNumeric(line.allocatedShippingRevenueExVatMinor),
            allocatedCodFeeRevenueExVatMinor: minorToNumeric(line.allocatedCodFeeRevenueExVatMinor),
            unitCostMinor: minorToNumeric(line.unitCostMinor),
            cogsMinor: minorToNumeric(line.cogsMinor),
            costSource: line.costSource,
            costHistoryId: line.costHistoryId,
            allocatedOutboundShippingMinor: minorToNumeric(line.allocatedOutboundShippingMinor),
            allocatedReturnShippingMinor: minorToNumeric(line.allocatedReturnShippingMinor),
            allocatedGatewayFeeMinor: minorToNumeric(line.allocatedGatewayFeeMinor),
            allocatedCodCostMinor: minorToNumeric(line.allocatedCodCostMinor),
            reversedQuantity: line.reversedQuantity,
            reversedRevenueExVatMinor: minorToNumeric(line.reversedRevenueExVatMinor),
            restockedCogsMinor: minorToNumeric(line.restockedCogsMinor),
            reversalImpactMinor: minorToNumeric(line.reversalImpactMinor),
            contributionMarginMinor: minorToNumeric(line.contributionMarginMinor),
            costCoveredRevenueExVatMinor: minorToNumeric(line.costCoveredRevenueExVatMinor),
            calcVersion: result.calcVersion,
          })),
        );
      }

      await this.markDirty(tx, result.storeId, result.businessDate, result.lines);
    });
  }

  /**
   * Marks the affected buckets, never rebuilds them.
   *
   * A late-arriving carrier cost — which is the normal case, not the exception —
   * dirties the ORDER's bucket, not today's. That is the whole reason the
   * business date is denormalized onto the profit row: without it this would
   * need a join to work out which day a fact from last Tuesday belongs to.
   */
  private async markDirty(
    tx: Parameters<Parameters<Database['transaction']>[0]>[0],
    storeId: StoreId,
    businessDate: LocalDate,
    lines: readonly OrderProfitLine[],
  ): Promise<void> {
    const now = new Date();
    await tx
      .insert(dailyStoreRollup)
      .values({ storeId, businessDate, dirty: true, dirtiedAt: now })
      .onConflictDoUpdate({
        target: [dailyStoreRollup.storeId, dailyStoreRollup.businessDate],
        set: { dirty: true, dirtiedAt: now },
      });

    const keys = new Map<string, { productId: string; variantId: string }>();
    for (const line of lines) {
      const variantId = line.platformVariantId ?? '';
      keys.set(`${line.platformProductId}|${variantId}`, {
        productId: line.platformProductId,
        variantId,
      });
    }
    if (keys.size === 0) return;

    await tx
      .insert(dailyVariantRollup)
      .values(
        [...keys.values()].map((key) => ({
          storeId,
          businessDate,
          platformProductId: key.productId,
          platformVariantId: key.variantId,
          dirty: true,
          dirtiedAt: now,
        })),
      )
      .onConflictDoUpdate({
        target: [
          dailyVariantRollup.storeId,
          dailyVariantRollup.businessDate,
          dailyVariantRollup.platformProductId,
          dailyVariantRollup.platformVariantId,
        ],
        set: { dirty: true, dirtiedAt: now },
      });
  }

  /**
   * The recompute sweep's query. Everything below the current version, oldest
   * first, so a `CALC_VERSION` bump drains rather than stampedes.
   */
  async findStaleOrderIds(storeId: StoreId, calcVersion: number, limit: number): Promise<readonly string[]> {
    const rows = await this.db
      .select({ orderId: orderProfit.orderId })
      .from(orderProfit)
      .where(and(eq(orderProfit.storeId, storeId), lt(orderProfit.calcVersion, calcVersion)))
      .orderBy(orderProfit.computedAt)
      .limit(limit);
    return rows.map((r) => r.orderId);
  }

  /**
   * Dirties every bucket a fee-rule change touched, so republishing rates is a
   * targeted recompute rather than a full rebuild of the store. This is what
   * `feeRuleSetId` on the profit row is for.
   */
  async markDirtyByFeeRuleSet(storeId: StoreId, feeRuleSetId: string): Promise<number> {
    const rows = await this.db
      .selectDistinct({ businessDate: orderProfit.businessDate })
      .from(orderProfit)
      .where(and(eq(orderProfit.storeId, storeId), eq(orderProfit.feeRuleSetId, feeRuleSetId)));
    // A rejected row has no business date, and nothing it contributed needs
    // rebuilding — it contributed nothing.
    const dates = rows.filter((r): r is { businessDate: string } => r.businessDate !== null);
    if (dates.length === 0) return 0;

    const now = new Date();
    await this.db
      .insert(dailyStoreRollup)
      .values(dates.map((d) => ({ storeId, businessDate: d.businessDate, dirty: true, dirtiedAt: now })))
      .onConflictDoUpdate({
        target: [dailyStoreRollup.storeId, dailyStoreRollup.businessDate],
        set: { dirty: true, dirtiedAt: now },
      });
    return dates.length;
  }
}
