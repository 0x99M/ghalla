import { CURRENCY_CODES, MAX_MINOR, isInstant } from '@ghalla/contracts';
import type {
  CanonicalOrder,
  CanonicalOrderItem,
  CanonicalReversal,
  CanonicalShipment,
} from '@ghalla/contracts';
import type { Diagnostic } from '../diagnostics.js';
import type { OrderProfitInput } from '../input.js';
import type { ResolvedCost } from '../cost.js';
import type { FeeFormula, FeeRuleSet } from '../fee-rules.js';
import { diagnostic, onOrder } from './diagnostics-builder.js';

/** Every cost, indexed the two ways a line can be resolved. */
export interface CostIndex {
  readonly byProductKey: ReadonlyMap<string, ResolvedCost>;
  readonly bySku: ReadonlyMap<string, ResolvedCost>;
}

export interface NormalizedInput {
  readonly order: CanonicalOrder;
  /**
   * Sorted by `platformLineId`. Deterministic ordering is a precondition for
   * every allocation invariant: re-ingesting the same order with its items in a
   * different order must produce identical per-SKU numbers.
   */
  readonly items: readonly CanonicalOrderItem[];
  readonly shipments: readonly CanonicalShipment[];
  readonly reversals: readonly CanonicalReversal[];
  readonly costs: CostIndex;
}

export function productKeyOf(platformProductId: string, platformVariantId: string | null): string {
  return `${platformProductId}|${platformVariantId ?? ''}`;
}

const validMinor = (value: number): boolean =>
  Number.isSafeInteger(value) && value <= MAX_MINOR && value >= -MAX_MINOR;

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * A rate card is merchant-transcribed data, so a bad one must name the rate
 * card rather than surface as an engine bug.
 *
 * Without this a fractional rate — a merchant typing 2.75 for 2.75% — produced
 * a silently 100x-wrong fee on the orders where the multiplication happened to
 * land on an integer and a dead-letter on the rest, partitioned by the parity
 * of the basket amount. A transposed floor and cap silently invented SAR 199 of
 * margin on a single order.
 */
function feeFormulaIsValid(formula: FeeFormula): boolean {
  if (!Number.isSafeInteger(formula.percentBps) || formula.percentBps < 0) return false;
  if (!Number.isSafeInteger(formula.feeVatBps) || formula.feeVatBps < 0 || formula.feeVatBps > 10_000) return false;
  if (!validMinor(formula.fixedMinor) || formula.fixedMinor < 0) return false;
  if (formula.minFeeMinor !== null && (!validMinor(formula.minFeeMinor) || formula.minFeeMinor < 0)) return false;
  if (formula.maxFeeMinor !== null && (!validMinor(formula.maxFeeMinor) || formula.maxFeeMinor < 0)) return false;
  if (formula.minFeeMinor !== null && formula.maxFeeMinor !== null && formula.minFeeMinor > formula.maxFeeMinor) {
    return false;
  }
  return true;
}

function validateFeeRuleSet(feeRuleSet: FeeRuleSet, fatal: Diagnostic[]): void {
  for (const rule of [...feeRuleSet.gateway, ...feeRuleSet.cod]) {
    if (!feeFormulaIsValid(rule)) fatal.push(onOrder('FEE_RULE_INVALID'));
  }
  for (const rule of feeRuleSet.shippingFallback) {
    if (!validMinor(rule.costMinor) || rule.costMinor < 0) fatal.push(onOrder('FEE_RULE_INVALID'));
  }

  // Two rules with the same key means which one applies depends on the order the
  // caller's query returned — a 2.75x swing in the fee from row order alone.
  // Rejecting is right where sorting would be wrong: sorting hides the
  // merchant's duplicated rate instead of surfacing it.
  const gatewayKeys = new Set<string>();
  for (const rule of feeRuleSet.gateway) {
    const key = `${rule.instrument ?? ''}|${rule.scheme ?? ''}|${rule.provider ?? ''}`;
    if (gatewayKeys.has(key)) fatal.push(onOrder('DUPLICATE_RULE_KEY'));
    gatewayKeys.add(key);
  }
  const codKeys = new Set<string>();
  for (const rule of feeRuleSet.cod) {
    const key = rule.carrier ?? '';
    if (codKeys.has(key)) fatal.push(onOrder('DUPLICATE_RULE_KEY'));
    codKeys.add(key);
  }

  // The same guard, for the same reason. `matchShippingRule` picks the first row
  // of the highest specificity, so two rows with one key mean the caller's
  // ORDER BY decides the cost — and shipping carries the dominant Saudi loss
  // shape, where a return to origin IS two shipping legs and nothing else.
  const shippingKeys = new Set<string>();
  for (const rule of feeRuleSet.shippingFallback) {
    const key = `${rule.countryCode ?? ''}|${rule.region ?? ''}|${rule.carrier ?? ''}|${rule.direction}`;
    if (shippingKeys.has(key)) fatal.push(onOrder('DUPLICATE_RULE_KEY'));
    shippingKeys.add(key);
  }
}

/**
 * The only path to `status: 'rejected'` from data the caller actually supplied.
 * The orchestrator's catch is the other, and it exists to make totality
 * unconditional rather than to handle anything foreseeable.
 *
 * What lands here are caller and ingestion defects, never merchant data gaps. A
 * missing cost is a warning the merchant can act on; an item belonging to a
 * different order is a bug that must be dead-lettered rather than retried,
 * because retrying produces the same wrong answer forever.
 */
export function normalizeAndValidate(input: Readonly<OrderProfitInput>): {
  readonly normalized: NormalizedInput | null;
  readonly diagnostics: readonly Diagnostic[];
} {
  const fatal: Diagnostic[] = [];

  // Structural gate first: everything below dereferences these.
  if (
    input === null ||
    typeof input !== 'object' ||
    input.order === null ||
    typeof input.order !== 'object' ||
    input.store === null ||
    typeof input.store !== 'object' ||
    input.feeRuleSet === null ||
    typeof input.feeRuleSet !== 'object'
  ) {
    return { normalized: null, diagnostics: [onOrder('MALFORMED_INPUT')] };
  }

  const { order, store, feeRuleSet } = input;
  const items = input.items ?? [];
  const shipments = input.shipments ?? [];
  const reversals = input.reversals ?? [];
  const costs = input.costs ?? [];

  // Three absent currencies are all `undefined` and so compare equal, which let
  // an input carrying no currency at all through as `computed` with
  // `currency: undefined` on a field typed CurrencyCode. `Minor` is
  // currency-free by design, so once such a row is persisted nothing can
  // recover which unit those halalas were.
  // Membership, not merely presence: the input is untrusted at runtime whatever
  // the type says, and an unknown code is as unrecoverable as an absent one.
  if (!(CURRENCY_CODES as readonly string[]).includes(store.currency)) {
    fatal.push(onOrder('MALFORMED_INPUT'));
  }
  if (order.currency !== store.currency) fatal.push(onOrder('CURRENCY_MISMATCH'));
  if (feeRuleSet.currency !== store.currency) fatal.push(onOrder('CURRENCY_MISMATCH'));

  // An absent timezone would otherwise reach Intl as `undefined`, which means
  // "use the runtime default" — making a merchant's business date depend on
  // which machine ran the job.
  if (typeof store.timezone !== 'string' || store.timezone === '') {
    fatal.push(onOrder('INVALID_TIMEZONE'));
  }
  if (typeof order.placedAt !== 'string' || !isInstant(order.placedAt)) {
    fatal.push(onOrder('MALFORMED_TIMESTAMP'));
  }

  validateFeeRuleSet(feeRuleSet, fatal);

  for (const money of [
    order.subtotalExVatMinor,
    order.vatAmountMinor,
    order.shippingChargedExVatMinor,
    order.codFeeChargedExVatMinor,
    order.totalIncVatMinor,
  ]) {
    if (!validMinor(money)) fatal.push(onOrder('NON_INTEGER_MINOR_UNITS'));
  }

  const itemIds = new Set<string>();
  const lineIds = new Set<string>();
  for (const item of items) {
    if (item.orderId !== order.id) {
      fatal.push(diagnostic('ITEM_ORDER_ID_MISMATCH', { kind: 'line', orderItemId: item.id }));
    }
    if (itemIds.has(item.id)) {
      // Caught here rather than left to the allocator, whose duplicate-key throw
      // would dead-letter a plain adapter or upsert bug as an engine bug.
      fatal.push(diagnostic('DUPLICATE_ITEM_ID', { kind: 'line', orderItemId: item.id }));
    }
    itemIds.add(item.id);
    if (lineIds.has(item.platformLineId)) {
      // The normalized arrays are sorted by these keys, so a duplicate makes the
      // sort order depend on arrival order — and every allocation downstream is
      // built on that order being a function of the content.
      fatal.push(diagnostic('DUPLICATE_ITEM_ID', { kind: 'line', orderItemId: item.id }));
    }
    lineIds.add(item.platformLineId);

    if (typeof item.quantity !== 'number' || !Number.isSafeInteger(item.quantity)) {
      fatal.push(diagnostic('NON_INTEGER_QUANTITY', { kind: 'line', orderItemId: item.id }));
    } else if (item.quantity < 0) {
      fatal.push(diagnostic('NEGATIVE_QUANTITY', { kind: 'line', orderItemId: item.id }));
    }
    for (const money of [
      item.unitPriceExVatMinor,
      item.grossLineExVatMinor,
      item.lineDiscountExVatMinor,
      item.lineTotalExVatMinor,
    ]) {
      if (!validMinor(money)) {
        fatal.push(diagnostic('NON_INTEGER_MINOR_UNITS', { kind: 'line', orderItemId: item.id }));
      }
    }
  }

  const reversalIds = new Set<string>();
  for (const reversal of reversals) {
    if (reversalIds.has(reversal.id)) {
      fatal.push(diagnostic('DUPLICATE_ITEM_ID', { kind: 'reversal', reversalId: reversal.id }));
    }
    reversalIds.add(reversal.id);
    if (reversal.orderId !== order.id) {
      fatal.push(diagnostic('REVERSAL_ORDER_ID_MISMATCH', { kind: 'reversal', reversalId: reversal.id }));
    }
    for (const line of reversal.lines ?? []) {
      // Split, like the order-item path. These codes become Arabic dashboard
      // copy, and telling a merchant they have "2.5 of a thing" when the value
      // is -1 sends them looking for a fraction that is not there.
      if (!Number.isSafeInteger(line.quantity)) {
        fatal.push(diagnostic('NON_INTEGER_QUANTITY', { kind: 'reversal', reversalId: reversal.id }));
      } else if (line.quantity < 0) {
        fatal.push(diagnostic('NEGATIVE_QUANTITY', { kind: 'reversal', reversalId: reversal.id }));
      }
      if (!validMinor(line.amountExVatMinor)) {
        fatal.push(diagnostic('NON_INTEGER_MINOR_UNITS', { kind: 'reversal', reversalId: reversal.id }));
      }
    }
  }

  const shipmentIds = new Set<string>();
  for (const shipment of shipments) {
    if (shipmentIds.has(shipment.id)) {
      // The engine SUMS carrier cost across shipments, so a duplicate is the
      // webhook-replay shape that double-counts the largest cost line. The
      // schema has a unique constraint for exactly this; the engine is fed
      // in-memory objects and needs its own.
      fatal.push(diagnostic('DUPLICATE_ITEM_ID', { kind: 'shipment', shipmentId: shipment.id }));
    }
    shipmentIds.add(shipment.id);
    if (shipment.carrierCostMinor !== null && !validMinor(shipment.carrierCostMinor)) {
      fatal.push(diagnostic('NON_INTEGER_MINOR_UNITS', { kind: 'shipment', shipmentId: shipment.id }));
    }
  }

  // Two cost rows for one key means the as-of query returned overlapping
  // validity windows: a persistence bug. Silently taking the last row would
  // make a merchant's profit depend on the order the database returned.
  const byProductKey = new Map<string, ResolvedCost>();
  const bySku = new Map<string, ResolvedCost>();
  for (const cost of costs) {
    if (!validMinor(cost.unitCostMinor)) fatal.push(onOrder('NON_INTEGER_MINOR_UNITS'));
    const key = productKeyOf(cost.platformProductId, cost.platformVariantId);
    if (byProductKey.has(key)) fatal.push(onOrder('DUPLICATE_COST_KEY'));
    byProductKey.set(key, cost);
    if (cost.sku !== null && cost.sku !== '') {
      if (bySku.has(cost.sku)) fatal.push(onOrder('DUPLICATE_COST_KEY'));
      bySku.set(cost.sku, cost);
    }
  }

  if (fatal.length > 0) return { normalized: null, diagnostics: fatal };

  return {
    normalized: {
      order,
      items: [...items].sort((a, b) => byText(a.platformLineId, b.platformLineId)),
      shipments: [...shipments].sort((a, b) => byText(a.id, b.id)),
      reversals: [...reversals].sort((a, b) => byText(a.id, b.id)),
      costs: { byProductKey, bySku },
    },
    diagnostics: [],
  };
}
