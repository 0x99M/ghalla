import type { Assert, AssertNoPii } from './pii.js';
import type { Attribution, CanonicalOrder, OrderDestination, OrderDiscount } from './order.js';
import type { CanonicalOrderItem } from './order-item.js';
import type { CanonicalProduct, CanonicalVariant, ProductKey } from './product.js';
import type { CanonicalReversal, CanonicalReversalLine } from './reversal.js';
import type { CanonicalShipment, ShipmentLine } from './shipment.js';
import type { CanonicalStore } from './store.js';
import type { PaymentBreakdown } from './payment.js';

/**
 * The proof, not the promise.
 *
 * Every canonical type is checked against the PII key deny-list here. Adding a
 * forbidden field anywhere in the model fails this file to compile, and the
 * error names the field. This is why `CanonicalOrderItem` carries `productName`
 * rather than `name`.
 *
 * Exported so it survives `noUnusedLocals` — the assertion has to run.
 */
export type PiiAudit = [
  Assert<AssertNoPii<CanonicalStore>>,
  Assert<AssertNoPii<CanonicalOrder>>,
  Assert<AssertNoPii<OrderDestination>>,
  Assert<AssertNoPii<OrderDiscount>>,
  Assert<AssertNoPii<Attribution>>,
  Assert<AssertNoPii<PaymentBreakdown>>,
  Assert<AssertNoPii<CanonicalOrderItem>>,
  Assert<AssertNoPii<CanonicalShipment>>,
  Assert<AssertNoPii<ShipmentLine>>,
  Assert<AssertNoPii<CanonicalProduct>>,
  Assert<AssertNoPii<CanonicalVariant>>,
  Assert<AssertNoPii<ProductKey>>,
  Assert<AssertNoPii<CanonicalReversal>>,
  Assert<AssertNoPii<CanonicalReversalLine>>,
];
