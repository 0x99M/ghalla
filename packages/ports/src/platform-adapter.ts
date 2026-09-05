import type {
  CanonicalProduct,
  CanonicalShipment,
  CanonicalStore,
  CanonicalVariant,
  PlatformId,
} from '@ghalla/contracts';
import type { Ingested } from '@ghalla/contracts/ingest';
import type { Cursor, DateRange, EntityRef, Page } from './primitives.js';
import type { PlatformCredentials } from './credentials.js';
import type { AuthGrant, WebhookDelivery, WebhookSecret, WebhookVerification } from './webhook.js';
import type { PlatformEvent } from './events.js';
import type { OrderBundle } from './bundle.js';

/**
 * What every platform integration must provide, and the complete list of things
 * the rest of the system is allowed to ask a platform for.
 *
 * Nothing here names a platform. If implementing this for a second platform
 * requires changing anything in `@ghalla/core`, the abstraction is wrong and
 * must be fixed then — while it is still cheap.
 */
export interface PlatformAdapter {
  readonly platform: PlatformId;

  // ------------------------------------------------------------ webhooks --

  verifyWebhook(delivery: WebhookDelivery, secret: WebhookSecret): WebhookVerification;
  parseWebhook(delivery: WebhookDelivery): PlatformEvent;

  // ------------------------------------------------------ auth lifecycle --

  exchangeAuthCode(grant: AuthGrant): Promise<PlatformCredentials>;
  /**
   * Implementations must serialize this per store. Where refresh tokens are
   * single-use and rotating, two concurrent refreshes spend the same token twice
   * and hard-kill the store's access.
   */
  refreshCredentials(credentials: PlatformCredentials): Promise<PlatformCredentials>;
  /** Uninstall and data-erasure handling. */
  revokeCredentials(credentials: PlatformCredentials): Promise<void>;

  // --------------------------------------------------------------- store --

  /** Without this the install flow would have to reach around the port on day one. */
  fetchStore(credentials: PlatformCredentials): Promise<Ingested<CanonicalStore>>;

  // -------------------------------------------------------------- orders --

  listOrders(range: DateRange, cursor: Cursor | null, credentials: PlatformCredentials): Promise<Page<EntityRef>>;

  /** One call. Any fan-out is an adapter implementation detail, invisible from here. */
  fetchOrderBundle(ref: EntityRef, credentials: PlatformCredentials): Promise<Ingested<OrderBundle>>;

  /**
   * Retained as a narrow method for exactly two callers: a shipment webhook, and
   * a targeted retry of a bundle that came back partial. Shipment facts —
   * including the carrier cost, when it exists at all — land days after the
   * order is otherwise final.
   */
  fetchShipments(ref: EntityRef, credentials: PlatformCredentials): Promise<Ingested<readonly CanonicalShipment[]>>;

  // ----------------------------------------------------------- catalogue --

  listProducts(cursor: Cursor | null, credentials: PlatformCredentials): Promise<Page<Ingested<CanonicalProduct>>>;
  /** Per-variant cost is often exposed only on the product side; this is how per-variant COGS gets seeded. */
  fetchVariants(ref: EntityRef, credentials: PlatformCredentials): Promise<Ingested<readonly CanonicalVariant[]>>;
}
