import type { CurrencyCode, StoreId } from '@ghalla/contracts';

/**
 * Everything about a store the engine is allowed to know.
 *
 * Deliberately not `CanonicalStore`: the engine has no business with an install
 * timestamp or a platform identity, and passing the whole entity invites a
 * future dependency on a field that will not be there in a fixture.
 */
export interface StoreProfitConfig {
  readonly storeId: StoreId;
  readonly currency: CurrencyCode;
  /** IANA zone. Owns the business-date boundary, and is passed explicitly so the engine never reads an ambient one. */
  readonly timezone: string;
  /** Decides whether VAT on gateway and courier invoices is a recoverable pass-through or a real cost. */
  readonly vatRegistered: boolean;
}
