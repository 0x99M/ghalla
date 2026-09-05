/**
 * @ghalla/contracts — the canonical, platform-neutral domain.
 *
 * Every adapter maps *into* these types; the profit engine only ever sees them.
 * Zero runtime dependencies, enforced in CI.
 *
 * Note what is NOT exported here: `Ingested<T>` and the raw platform payload
 * live at `@ghalla/contracts/ingest`, reachable only from the adapter boundary.
 */

export type { Brand } from './brand.js';

export type { Minor, Bps, CurrencyCode } from './money.js';
export {
  CURRENCY_CODES,
  MAX_MINOR,
  PrecisionError,
  currencyExponent,
  isBps,
  isMinor,
  toBps,
  toMinor,
  toMinorFromDecimal,
  toMinorFromFloat,
} from './money.js';

export type { Instant, LocalDate } from './time.js';
export { MalformedTimestampError, isInstant, isLocalDate, toInstant, toLocalDate } from './time.js';

export type {
  CalcVersion,
  CostHistoryId,
  CustomerRef,
  FeeRuleSetId,
  Id,
  OrderId,
  OrderItemId,
  PlatformId,
  ReversalId,
  ShipmentId,
  StoreId,
} from './ids.js';
export {
  MalformedIdError,
  idFromString,
  isCustomerRef,
  isPlatformId,
  toCalcVersion,
  toCustomerRef,
  toOrderId,
  toOrderItemId,
  toPlatformId,
  toReversalId,
  toShipmentId,
  toStoreId,
} from './ids.js';

export type {
  CardScheme,
  CarrierSlug,
  CostSource,
  Device,
  FulfillmentMethod,
  FulfillmentState,
  OrderLifecycle,
  PaymentInstrument,
  PaymentLegState,
  PaymentState,
  ProviderSlug,
  RestockOutcome,
  ReversalKind,
  ReversalReason,
  ShipmentDirection,
  ShipmentStatus,
  WalletSlug,
} from './enums.js';
export {
  CARD_SCHEMES,
  COST_SOURCES,
  DEVICES,
  EXACT_COST_SOURCES,
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
} from './enums.js';

export type { Assert, AssertNoPii, ForbiddenKey } from './pii.js';
export type { PiiAudit } from './pii-audit.js';

export type { CanonicalStore } from './store.js';
export type { PaymentBreakdown } from './payment.js';
export type { Attribution, CanonicalOrder, OrderDestination, OrderDiscount } from './order.js';
export { ORDER_RECONCILIATION_IDENTITY } from './order.js';
export type { CanonicalOrderItem } from './order-item.js';
export type { CanonicalShipment, ShipmentLine } from './shipment.js';
export type { CanonicalProduct, CanonicalVariant, ProductKey } from './product.js';
export type { CanonicalReversal, CanonicalReversalLine } from './reversal.js';
export { REVERSAL_RECONCILIATION_IDENTITY } from './reversal.js';
