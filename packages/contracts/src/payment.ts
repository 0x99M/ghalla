import type { CardScheme, PaymentInstrument, PaymentLegState, ProviderSlug, WalletSlug } from './enums.js';
import type { Minor } from './money.js';

/**
 * One leg of an order's payment.
 *
 * Four fields where a naive model has one, because a single `method` enum is a
 * category error: it makes a card network (`mada`) and a presentment wrapper
 * (`applepay`) peers of a rail (`card`). Payment processors model these as
 * independent fields for exactly that reason.
 *
 * The cost of collapsing them is not cosmetic. A wallet-backed order priced as
 * a single "applepay" rate is wrong by roughly 3x depending on whether the card
 * behind it was domestic debit or an international credit card — and the axis
 * that was discarded at ingestion can never be recovered from stored data.
 */
export interface PaymentBreakdown {
  readonly instrument: PaymentInstrument;
  /** The card network. `null` iff `instrument !== 'card'`; `'unknown'` when the platform will not say. */
  readonly scheme: CardScheme | null;
  /**
   * The presentment wrapper: `apple_pay`, `google_pay`, `stc_pay`, ...
   * Descriptive, not a fee-rule key — a wallet is priced as the scheme behind it.
   */
  readonly wallet: WalletSlug | null;
  /** Normalized processor slug. The third component of the fee-rule key: the same domestic
   *  debit transaction is priced differently by every processor, and rates are negotiated. */
  readonly provider: ProviderSlug | null;
  /** The platform's verbatim label. Logged for unknown-value triage; never branched on outside an adapter. */
  readonly rawMethodLabel: string;
  /** An uncaptured leg accrues no fee. Some platforms report a placeholder method on unpaid orders. */
  readonly state: PaymentLegState;
  /**
   * VAT-INCLUSIVE amount actually taken from the customer: items + VAT +
   * shipping + COD fee. Named for its basis on purpose — every neighbouring
   * money field is `ExVat`, and a bare `amount` invites an adapter author to
   * populate it ex-VAT, understating every gateway fee by 15%.
   */
  readonly amountGrossMinor: Minor;
  /** Processor transaction reference. The only join key to a future settlement line. */
  readonly transactionRef: string | null;
}
