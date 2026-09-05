import type { z } from 'zod';
import type {
  Attribution,
  CanonicalOrder,
  CanonicalOrderItem,
  CanonicalProduct,
  CanonicalReversal,
  CanonicalReversalLine,
  CanonicalShipment,
  CanonicalStore,
  CanonicalVariant,
  OrderDestination,
  OrderDiscount,
  PaymentBreakdown,
  ProductKey,
  ShipmentLine,
} from '@ghalla/contracts';
import type { Expect, Matches } from './assert.js';
import type {
  AttributionSchema,
  CanonicalOrderItemSchema,
  CanonicalOrderSchema,
  CanonicalProductSchema,
  CanonicalReversalLineSchema,
  CanonicalReversalSchema,
  CanonicalShipmentSchema,
  CanonicalStoreSchema,
  CanonicalVariantSchema,
  OrderDestinationSchema,
  OrderDiscountSchema,
  PaymentBreakdownSchema,
  ProductKeySchema,
  ShipmentLineSchema,
} from './canonical.js';

/**
 * The whole justification for splitting schemas out of contracts.
 *
 * Every canonical type is declared twice — once as a hand-written interface with
 * no runtime dependencies, once as a zod schema. These assertions bind the two.
 * Add a field to one and forget the other, and this file stops compiling.
 *
 * Exported so it survives `noUnusedLocals`; the check has to actually run.
 */
export type DriftAudit = [
  Expect<Matches<z.infer<typeof CanonicalStoreSchema>, CanonicalStore>>,
  Expect<Matches<z.infer<typeof PaymentBreakdownSchema>, PaymentBreakdown>>,
  Expect<Matches<z.infer<typeof OrderDestinationSchema>, OrderDestination>>,
  Expect<Matches<z.infer<typeof OrderDiscountSchema>, OrderDiscount>>,
  Expect<Matches<z.infer<typeof AttributionSchema>, Attribution>>,
  Expect<Matches<z.infer<typeof CanonicalOrderSchema>, CanonicalOrder>>,
  Expect<Matches<z.infer<typeof CanonicalOrderItemSchema>, CanonicalOrderItem>>,
  Expect<Matches<z.infer<typeof ShipmentLineSchema>, ShipmentLine>>,
  Expect<Matches<z.infer<typeof CanonicalShipmentSchema>, CanonicalShipment>>,
  Expect<Matches<z.infer<typeof CanonicalProductSchema>, CanonicalProduct>>,
  Expect<Matches<z.infer<typeof CanonicalVariantSchema>, CanonicalVariant>>,
  Expect<Matches<z.infer<typeof ProductKeySchema>, ProductKey>>,
  Expect<Matches<z.infer<typeof CanonicalReversalLineSchema>, CanonicalReversalLine>>,
  Expect<Matches<z.infer<typeof CanonicalReversalSchema>, CanonicalReversal>>,
];
