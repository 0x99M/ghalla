import type { CarrierSlug, ShipmentDirection, ShipmentStatus } from './enums.js';
import type { Minor } from './money.js';
import type { OrderId, OrderItemId, ShipmentId } from './ids.js';
import type { Instant } from './time.js';

/**
 * Which lines travelled in this parcel.
 *
 * Read by the engine: when every live leg reports its mapping, each parcel's
 * cost is attributed to the lines that were actually in it. That matters
 * because revenue share is ANTI-correlated with freight in split fulfilment — a
 * heavy cheap item and a light expensive one — and getting it backwards flips a
 * SKU's margin sign. Empty falls back to an order-wide revenue split.
 */
export interface ShipmentLine {
  readonly orderItemId: OrderItemId;
  readonly quantity: number;
}

export interface CanonicalShipment {
  /**
   * A shipment needs an identity for the same reason an order does: the engine
   * sums carrier cost across shipments, and without a key, webhook replay and
   * re-ingestion double-count the largest cost line in the model.
   */
  readonly id: ShipmentId;
  readonly orderId: OrderId;
  readonly platformShipmentId: string;
  readonly direction: ShipmentDirection;
  /**
   * `returned_to_origin` is how an RTO becomes detectable from the shipment
   * record at all — and RTO impact is a headline deliverable. Without it, a
   * parcel cancelled before dispatch is indistinguishable from one in transit.
   */
  readonly status: ShipmentStatus;
  /** Normalized lowercase slug. A free string fragments the zone rate table across three spellings of one courier. */
  readonly carrier: CarrierSlug;
  readonly rawCarrierLabel: string;
  /**
   * What the courier actually billed the merchant, or `null` when unreported.
   *
   * Convention: the merchant's true net cash cost — net of recoverable input
   * VAT when the store is VAT-registered, gross when it is not. Deliberately not
   * named `ExVat`, because for an unregistered merchant the VAT on that invoice
   * is a permanent cost that belongs inside the number.
   *
   * Expect `null` on essentially every shipment: neither platform exposes
   * courier cost to a general merchant application. The engine's fallback rule
   * is the primary path here, not the exception.
   */
  readonly carrierCostMinor: Minor | null;
  /** Empty when the platform does not report the mapping. */
  readonly lines: readonly ShipmentLine[];
  readonly shippedAt: Instant | null;
  readonly deliveredAt: Instant | null;
  readonly platformUpdatedAt: Instant | null;
}
