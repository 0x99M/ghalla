import type { Bps, CurrencyCode } from './money.js';
import type { PlatformId, StoreId } from './ids.js';
import type { Instant } from './time.js';

export interface CanonicalStore {
  readonly id: StoreId;
  readonly platform: PlatformId;
  readonly platformStoreId: string;
  readonly currency: CurrencyCode;
  /** IANA zone, e.g. `Asia/Riyadh`. Owns the business-date boundary for every rollup. */
  readonly timezone: string;
  /** Basis points. 1500 for Saudi Arabia. Never a 0.15 float. */
  readonly vatRateBps: Bps;
  /**
   * Distinct from `vatRateBps === 0`, and the difference is real money.
   *
   * An unregistered merchant cannot reclaim input VAT, so the 15% on their
   * courier and gateway invoices is a permanent cost that belongs inside their
   * margin. A registered merchant recovers it in full and it does not. Saudi
   * e-commerce sellers below the mandatory registration threshold are squarely
   * the target customer, and getting this wrong is ~15% of two cost lines —
   * which lands right on the loss-maker threshold, in the flattering direction.
   */
  readonly vatRegistered: boolean;
  readonly installedAt: Instant;
}
