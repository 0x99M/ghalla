import { z } from 'zod';
import {
  CARD_SCHEMES,
  DEVICES,
  FULFILLMENT_METHODS,
  FULFILLMENT_STATES,
  ORDER_LIFECYCLES,
  PAYMENT_INSTRUMENTS,
  PAYMENT_LEG_STATES,
  PAYMENT_STATES,
  RESTOCK_OUTCOMES,
  REVERSAL_KINDS,
  REVERSAL_REASONS,
  SHIPMENT_DIRECTIONS,
  SHIPMENT_STATUSES,
} from '@ghalla/contracts';
import {
  CurrencyCodeSchema,
  CustomerRefSchema,
  InstantSchema,
  MinorSchema,
  PlatformIdSchema,
  QuantitySchema,
  RateBpsSchema,
  RawLabelSchema,
  SlugSchema,
  idSchema,
} from './primitives.js';

/**
 * Every object here is STRICT.
 *
 * An unknown key is a hard failure rather than a silently stripped one, because
 * the way customer data leaks into this system is a mapper that spreads a raw
 * platform payload instead of naming its fields. Stripping would make that
 * mistake invisible; failing makes it a test.
 */

// ------------------------------------------------------------------ store --

export const CanonicalStoreSchema = z.strictObject({
  id: idSchema<'store'>(),
  platform: PlatformIdSchema,
  platformStoreId: z.string().min(1),
  currency: CurrencyCodeSchema,
  timezone: z.string().min(1),
  vatRateBps: RateBpsSchema,
  vatRegistered: z.boolean(),
  installedAt: InstantSchema,
});

// ---------------------------------------------------------------- payment --

export const PaymentBreakdownSchema = z
  .strictObject({
    instrument: z.enum(PAYMENT_INSTRUMENTS),
    scheme: z.enum(CARD_SCHEMES).nullable(),
    wallet: SlugSchema.nullable(),
    provider: SlugSchema.nullable(),
    rawMethodLabel: RawLabelSchema,
    state: z.enum(PAYMENT_LEG_STATES),
    amountGrossMinor: MinorSchema,
    transactionRef: z.string().nullable(),
  })
  .refine((p) => (p.scheme === null) === (p.instrument !== 'card'), {
    error: 'A card scheme is required for card payments and forbidden for every other instrument.',
    path: ['scheme'],
  });

// ------------------------------------------------------------------ order --

export const OrderDestinationSchema = z.strictObject({
  countryCode: z.string().length(2),
  region: z.string().nullable(),
  city: z.string().nullable(),
});

export const OrderDiscountSchema = z.strictObject({
  code: z.string().nullable(),
  target: z.enum(['items', 'shipping', 'cod_fee']),
  reflectedInComponent: z.boolean(),
  amountExVatMinor: MinorSchema,
});

export const AttributionSchema = z.strictObject({
  device: z.enum(DEVICES),
  referrerHost: z
    .string()
    .refine((h) => !h.includes('/') && !h.includes('?'), {
      error: 'Host only. Path and query string carry search terms and identifiers; the adapter strips them.',
    })
    .nullable(),
});

export const CanonicalOrderSchema = z.strictObject({
  id: idSchema<'order'>(),
  storeId: idSchema<'store'>(),
  platformOrderId: z.string().min(1),
  placedAt: InstantSchema,
  platformUpdatedAt: InstantSchema.nullable(),

  lifecycle: z.enum(ORDER_LIFECYCLES),
  paymentState: z.enum(PAYMENT_STATES),
  fulfillmentState: z.enum(FULFILLMENT_STATES),
  platformStatusId: z.string().nullable(),
  rawStatusLabel: RawLabelSchema,
  isTest: z.boolean(),

  fulfillmentMethod: z.enum(FULFILLMENT_METHODS),
  destination: OrderDestinationSchema.nullable(),

  currency: CurrencyCodeSchema,
  vatRateBps: RateBpsSchema,

  subtotalExVatMinor: MinorSchema,
  vatAmountMinor: MinorSchema,
  shippingChargedExVatMinor: MinorSchema,
  codFeeChargedExVatMinor: MinorSchema,
  totalIncVatMinor: MinorSchema,

  discounts: z.array(OrderDiscountSchema).readonly(),
  payments: z.array(PaymentBreakdownSchema).readonly(),

  customerRef: CustomerRefSchema.nullable(),
  attribution: AttributionSchema.nullable(),
});

// ------------------------------------------------------------- order item --

export const CanonicalOrderItemSchema = z
  .strictObject({
    id: idSchema<'orderItem'>(),
    orderId: idSchema<'order'>(),
    platformLineId: z.string().min(1),
    platformProductId: z.string().min(1),
    platformVariantId: z.string().nullable(),
    sku: z.string().nullable(),
    productName: z.string(),
    quantity: QuantitySchema,
    unitPriceExVatMinor: MinorSchema,
    grossLineExVatMinor: MinorSchema,
    lineDiscountExVatMinor: MinorSchema,
    lineTotalExVatMinor: MinorSchema,
  })
  .refine((i) => i.lineTotalExVatMinor === i.grossLineExVatMinor - i.lineDiscountExVatMinor, {
    error: 'lineTotal must equal gross minus the line discount. A mapper that computes it differently is wrong.',
    path: ['lineTotalExVatMinor'],
  });

// --------------------------------------------------------------- shipment --

export const ShipmentLineSchema = z.strictObject({
  orderItemId: idSchema<'orderItem'>(),
  quantity: QuantitySchema,
});

export const CanonicalShipmentSchema = z.strictObject({
  id: idSchema<'shipment'>(),
  orderId: idSchema<'order'>(),
  platformShipmentId: z.string().min(1),
  direction: z.enum(SHIPMENT_DIRECTIONS),
  status: z.enum(SHIPMENT_STATUSES),
  carrier: SlugSchema,
  rawCarrierLabel: RawLabelSchema,
  carrierCostMinor: MinorSchema.nullable(),
  lines: z.array(ShipmentLineSchema).readonly(),
  shippedAt: InstantSchema.nullable(),
  deliveredAt: InstantSchema.nullable(),
  platformUpdatedAt: InstantSchema.nullable(),
});

// ---------------------------------------------------------------- product --

export const CanonicalProductSchema = z.strictObject({
  storeId: idSchema<'store'>(),
  platformProductId: z.string().min(1),
  sku: z.string().nullable(),
  productName: z.string(),
  platformCostMinor: MinorSchema.nullable(),
  listPriceExVatMinor: MinorSchema.nullable(),
  active: z.boolean(),
  platformUpdatedAt: InstantSchema.nullable(),
});

export const CanonicalVariantSchema = z.strictObject({
  storeId: idSchema<'store'>(),
  platformProductId: z.string().min(1),
  platformVariantId: z.string().min(1),
  sku: z.string().nullable(),
  variantName: z.string(),
  platformCostMinor: MinorSchema.nullable(),
  listPriceExVatMinor: MinorSchema.nullable(),
  active: z.boolean(),
});

export const ProductKeySchema = z.strictObject({
  storeId: idSchema<'store'>(),
  platformProductId: z.string().min(1),
  platformVariantId: z.string().nullable(),
});

// --------------------------------------------------------------- reversal --

export const CanonicalReversalLineSchema = z.strictObject({
  orderItemId: idSchema<'orderItem'>(),
  quantity: QuantitySchema,
  amountExVatMinor: MinorSchema,
  restockOutcome: z.enum(RESTOCK_OUTCOMES),
});

export const CanonicalReversalSchema = z
  .strictObject({
    id: idSchema<'reversal'>(),
    orderId: idSchema<'order'>(),
    platformReversalId: z.string().nullable(),
    kind: z.enum(REVERSAL_KINDS),
    reason: z.enum(REVERSAL_REASONS),
    rawReasonLabel: RawLabelSchema.nullable(),
    occurredAt: InstantSchema,

    amountExVatMinor: MinorSchema,
    shippingRefundExVatMinor: MinorSchema,
    codFeeRefundExVatMinor: MinorSchema,
    adjustmentExVatMinor: MinorSchema,
    vatMinor: MinorSchema,
    totalIncVatMinor: MinorSchema,

    lines: z.array(CanonicalReversalLineSchema).readonly().nullable(),
    restockOutcome: z.enum(RESTOCK_OUTCOMES),
    platformUpdatedAt: InstantSchema.nullable(),
  })
  .refine(
    (r) =>
      r.totalIncVatMinor ===
      r.amountExVatMinor + r.shippingRefundExVatMinor + r.codFeeRefundExVatMinor + r.adjustmentExVatMinor + r.vatMinor,
    {
      error: 'A reversal must account for every halala: items + shipping + COD fee + adjustment + VAT = total.',
      path: ['totalIncVatMinor'],
    },
  )
  .refine((r) => r.lines === null || r.lines.reduce((sum, l) => sum + l.amountExVatMinor, 0) === r.amountExVatMinor, {
    error: 'Reversal line amounts must sum to the item revenue reversed.',
    path: ['lines'],
  });
