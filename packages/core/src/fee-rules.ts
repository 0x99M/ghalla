import type { Bps, CardScheme, CarrierSlug, FeeRuleSetId, Minor, PaymentInstrument, ProviderSlug, ShipmentDirection } from '@ghalla/contracts';

/**
 * One shape for every fee-like cost, because they are all the same arithmetic
 * with different keys.
 */
export interface FeeFormula {
  readonly percentBps: Bps;
  readonly fixedMinor: Minor;
  /** Couriers commonly quote a percentage with a floor. */
  readonly minFeeMinor: Minor | null;
  /**
   * Domestic debit is commonly priced as a percentage *capped* per transaction.
   * Uncapped, every high-value order is overcharged — rare at a typical basket
   * size, concentrated in furniture, electronics and jewellery, and the very
   * first order a merchant spot-checks against their statement.
   */
  readonly maxFeeMinor: Minor | null;
  /**
   * VAT charged on the fee itself. Saudi VAT law taxes explicit fees and
   * commissions, so omitting this understates gateway cost by 15% on every card
   * order — uniformly, in the flattering direction.
   */
  readonly feeVatBps: Bps;
  /**
   * Whether the merchant's quoted rate already includes that VAT.
   *
   * Without this flag a 2.75% inclusive quote is indistinguishable from a 2.75%
   * exclusive one, and the engine is 15% wrong for one class of merchant with no
   * way to tell which.
   */
  readonly ratesIncludeVat: boolean;
  /** Feeds the confidence term: a published default is not the same fact as a merchant's own contract. */
  readonly source: 'merchant_entered' | 'gateway_statement' | 'default_table';
}

/**
 * Matched on the three payment axes. `null` matches anything, and specificity
 * wins: instrument + scheme + provider beats instrument + scheme beats
 * instrument alone.
 */
export interface GatewayFeeRule extends FeeFormula {
  readonly instrument: PaymentInstrument | null;
  readonly scheme: CardScheme | null;
  readonly provider: ProviderSlug | null;
}

/**
 * Cash-on-delivery handling, keyed by CARRIER — not a single store-level
 * constant.
 *
 * Couriers publish this as a fixed amount *plus* a percentage, and the rate
 * differs between couriers a single store uses on the same day. A flat constant
 * diverges without bound across the basket-size distribution, and it diverges in
 * the direction that flatters margin.
 */
export interface CodFeeRule extends FeeFormula {
  readonly carrier: CarrierSlug | null;
}

/**
 * What a shipment costs when the courier's actual charge is unavailable — which
 * is essentially always, on both platforms in scope.
 *
 * A `null` on every field is a legitimate configuration: a single catch-all row
 * is the "one blended number the merchant typed at onboarding" case, and the
 * same type supports a full per-region rate card without change.
 */
export interface ShippingFallbackRule {
  readonly countryCode: string | null;
  readonly region: string | null;
  readonly carrier: CarrierSlug | null;
  readonly direction: ShipmentDirection | 'any';
  /** The merchant's true net cash cost per shipment. */
  readonly costMinor: Minor;
}

/**
 * A versioned set of rules. Identified, so that publishing new rates is a
 * targeted recompute of the affected orders rather than a full rebuild.
 *
 * Arrays rather than keyed records: the matching is specificity-based, and a
 * `Record` keyed by payment method cannot express "any card, from this
 * processor" — nor does it survive a JSON round trip into a golden fixture with
 * its ordering intact.
 */
export interface FeeRuleSet {
  readonly id: FeeRuleSetId;
  readonly gateway: readonly GatewayFeeRule[];
  readonly cod: readonly CodFeeRule[];
  readonly shippingFallback: readonly ShippingFallbackRule[];
}
