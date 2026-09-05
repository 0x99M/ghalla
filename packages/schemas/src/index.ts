/**
 * @ghalla/schemas — runtime validation for the canonical domain.
 *
 * Deliberately NOT part of @ghalla/contracts. Contracts must have zero runtime
 * dependencies, and a validator imported at module load would sit in the pure
 * engine's dependency graph and make `.parse()` reachable from the engine
 * through a re-export. Two packages make that boundary a fact of the lockfile
 * rather than a rule people remember.
 *
 * The price is that every canonical type is declared twice. `DriftAudit` in
 * ./drift.ts is what makes that price safe to pay.
 */

export type { Expect, Matches, MutuallyAssignable } from './assert.js';

export {
  BpsSchema,
  CurrencyCodeSchema,
  CustomerRefSchema,
  InstantSchema,
  LocalDateSchema,
  MinorSchema,
  PlatformIdSchema,
  QuantitySchema,
  SlugSchema,
  idSchema,
} from './primitives.js';

export {
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

export type { DriftAudit } from './drift.js';
