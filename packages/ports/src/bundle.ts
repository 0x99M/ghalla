import type {
  CanonicalOrder,
  CanonicalOrderItem,
  CanonicalReversal,
  CanonicalShipment,
  Instant,
} from '@ghalla/contracts';

export const BUNDLE_PARTS = ['items', 'shipments', 'reversals'] as const;
export type BundlePart = (typeof BUNDLE_PARTS)[number];

/**
 * Everything about one order, in one call.
 *
 * This is the resolution of a tension the naive port design loses. One platform
 * needs three HTTP calls to assemble this; another returns it all in one. With
 * three separate port methods, *ingestion* becomes the thing sequencing them —
 * it has to know that one platform needs the order before it can address the
 * shipments, and it would change shape when the second adapter lands. That is
 * precisely the platform-specific structure the architecture exists to keep out
 * of the shared layer.
 */
export interface OrderBundle {
  readonly order: CanonicalOrder;
  readonly items: readonly CanonicalOrderItem[];
  readonly shipments: readonly CanonicalShipment[];
  readonly reversals: readonly CanonicalReversal[];
  readonly fetchedAt: Instant;
  /**
   * Parts the adapter fanned out for and could not retrieve. Empty means a
   * complete snapshot.
   *
   * Strictly better than splitting the port: the retry decision is made with
   * adapter knowledge of which endpoint was flaky and executed by ingestion's
   * scheduler — and "no shipments exist" stops being indistinguishable from
   * "shipments could not be fetched", which otherwise produces a confidently
   * wrong number.
   */
  readonly partial: readonly BundlePart[];
}
