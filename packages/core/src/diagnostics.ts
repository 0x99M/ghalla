import type { OrderItemId, ReversalId, ShipmentId } from '@ghalla/contracts';

/**
 * Why a number is what it is.
 *
 * These are not telemetry. "No cost recorded for this SKU" is the call to action
 * that drives cost entry, which is the product's entire activation loop — the
 * merchant has to be able to see it, in Arabic, next to the number it degraded.
 */
export const DIAGNOSTIC_CODES = [
  // --- warnings: the result still carries usable numbers, with lower confidence
  'COST_MISSING',
  'COST_ESTIMATED',
  'CARRIER_COST_MISSING',
  'SHIPPING_FALLBACK_USED',
  'SHIPPING_FALLBACK_MISSING',
  'NO_OUTBOUND_SHIPMENT',
  'FEE_RULE_MISSING',
  'FEE_RULE_DEFAULT_USED',
  'UNKNOWN_PAYMENT_INSTRUMENT',
  'CARD_SCHEME_UNKNOWN',
  'COD_FEE_RULE_MISSING',
  'RESTOCK_UNKNOWN',
  'REVERSAL_LINES_ALLOCATED',
  'REVERSAL_LINE_UNMATCHED',
  'TOTALS_DO_NOT_RECONCILE',
  'ORDER_HAS_NO_ITEMS',
  'RECOGNITION_COST_ONLY',
  'ORDER_EXCLUDED',

  // --- fatal: caller or ingestion defects. Dead-letter these; never retry them.
  'CURRENCY_MISMATCH',
  'ITEM_ORDER_ID_MISMATCH',
  'REVERSAL_ORDER_ID_MISMATCH',
  'NON_INTEGER_MINOR_UNITS',
  'NEGATIVE_QUANTITY',
  /** Two cost rows for one product key: the as-of query returned overlapping validity windows. */
  'DUPLICATE_COST_KEY',
] as const;
export type DiagnosticCode = (typeof DIAGNOSTIC_CODES)[number];

/**
 * No free-text `detail`, and no `affectedRevenueMinor`.
 *
 * The merchant-facing copy comes from the code plus translation — the dashboard
 * is Arabic and right-to-left, so an English string baked into the engine is
 * unusable. And a money-impact estimate would be a second representation of a
 * fact the totals already carry, which is how two fields that must agree start
 * disagreeing.
 */
export interface Diagnostic {
  readonly code: DiagnosticCode;
  readonly severity: 'warning' | 'fatal';
  readonly subject:
    | { readonly kind: 'order' }
    | { readonly kind: 'line'; readonly orderItemId: OrderItemId }
    | { readonly kind: 'shipment'; readonly shipmentId: ShipmentId }
    | { readonly kind: 'payment'; readonly index: number }
    | { readonly kind: 'reversal'; readonly reversalId: ReversalId };
}
