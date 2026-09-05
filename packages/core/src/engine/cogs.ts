import { EXACT_COST_SOURCES, toMinor } from '@ghalla/contracts';
import type { CanonicalOrderItem, CostHistoryId, CostSource, Minor, OrderItemId } from '@ghalla/contracts';
import type { Diagnostic } from '../diagnostics.js';
import { addMinor, assertInRange } from '../money.js';
import { diagnostic } from './diagnostics-builder.js';
import type { Computed } from './diagnostics-builder.js';
import { productKeyOf } from './normalize.js';
import type { CostIndex } from './normalize.js';

const ZERO = toMinor(0);

export interface LineCogs {
  readonly orderItemId: OrderItemId;
  readonly unitCostMinor: Minor;
  readonly cogsMinor: Minor;
  readonly source: CostSource;
  readonly costHistoryId: CostHistoryId | null;
  /** True when the cost is good enough to count toward revenue coverage. */
  readonly covered: boolean;
}

export interface OrderCogs {
  readonly lines: readonly LineCogs[];
  readonly cogsMinor: Minor;
  readonly anyMissing: boolean;
  readonly anyEstimated: boolean;
}

/**
 * Resolves each line's cost, by product key first and then by SKU.
 *
 * The SKU fallback is not a nicety: some platforms put no variant identity on
 * order lines at all, which makes the SKU the de facto variant key there. It
 * stays a fallback because SKU is merchant-entered free text — blank,
 * duplicated and edited in place — so keying on it first would merge unrelated
 * products.
 *
 * A miss contributes ZERO to COGS and says so loudly. That direction
 * OVERSTATES profit, which is why `confidence.cogs` becomes `missing` rather
 * than `estimated`: an uncosted SKU otherwise reports as the most profitable
 * product in the catalogue, on day one of every install, in the exact feature
 * where being wrong is worst.
 */
export function computeCogs(items: readonly CanonicalOrderItem[], costs: CostIndex): Computed<OrderCogs> {
  const diagnostics: Diagnostic[] = [];
  const lines: LineCogs[] = [];
  let anyMissing = false;
  let anyEstimated = false;

  for (const item of items) {
    const byKey = costs.byProductKey.get(productKeyOf(item.platformProductId, item.platformVariantId));
    const bySku = item.sku === null || item.sku === '' ? undefined : costs.bySku.get(item.sku);
    const resolved = byKey ?? bySku;

    if (resolved === undefined) {
      anyMissing = true;
      diagnostics.push(diagnostic('COST_MISSING', { kind: 'line', orderItemId: item.id }));
      lines.push({
        orderItemId: item.id,
        unitCostMinor: ZERO,
        cogsMinor: ZERO,
        source: 'none',
        costHistoryId: null,
        covered: false,
      });
      continue;
    }

    const exact = EXACT_COST_SOURCES.includes(resolved.source);
    if (!exact) {
      anyEstimated = true;
      diagnostics.push(diagnostic('COST_ESTIMATED', { kind: 'line', orderItemId: item.id }));
    }
    lines.push({
      orderItemId: item.id,
      unitCostMinor: resolved.unitCostMinor,
      cogsMinor: assertInRange(resolved.unitCostMinor * item.quantity, `COGS for ${item.id}`),
      source: resolved.source,
      costHistoryId: resolved.costHistoryId,
      covered: exact,
    });
  }

  return {
    value: {
      lines,
      cogsMinor: addMinor(...lines.map((l) => l.cogsMinor)),
      anyMissing,
      anyEstimated,
    },
    diagnostics,
  };
}
