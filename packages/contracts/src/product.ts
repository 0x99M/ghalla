import type { Minor } from './money.js';
import type { StoreId } from './ids.js';
import type { Instant } from './time.js';

export interface CanonicalProduct {
  readonly storeId: StoreId;
  readonly platformProductId: string;
  readonly sku: string | null;
  readonly productName: string;
  /**
   * Cost as the platform reports it — the seed for cost history on day one.
   * Adapters map a platform's `0` to `null`: "free" and "we don't know" must
   * never be the same value, because one of them reports 100% margin.
   */
  readonly platformCostMinor: Minor | null;
  /** Named for its VAT basis: displayed Saudi retail prices are legally VAT-inclusive, so the adapter normalizes. */
  readonly listPriceExVatMinor: Minor | null;
  readonly active: boolean;
  readonly platformUpdatedAt: Instant | null;
}

export interface CanonicalVariant {
  readonly storeId: StoreId;
  readonly platformProductId: string;
  readonly platformVariantId: string;
  readonly sku: string | null;
  readonly variantName: string;
  readonly platformCostMinor: Minor | null;
  readonly listPriceExVatMinor: Minor | null;
  readonly active: boolean;
}

/**
 * The key for cost history and for every per-product rollup. NOT the SKU.
 *
 * SKU is merchant-entered free text: frequently blank, duplicated across
 * variants, reused after deletion, and edited in place. Keying on it merges
 * unrelated products, splits identical ones, and makes a product's entire
 * history jump the day a merchant tidies up their catalogue. SKU stays a display
 * attribute and a secondary cost-resolution key — necessary, because some
 * platforms put no variant identity on order lines.
 */
export interface ProductKey {
  readonly storeId: StoreId;
  readonly platformProductId: string;
  readonly platformVariantId: string | null;
}
