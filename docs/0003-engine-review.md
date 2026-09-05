# 0003 — What an adversarial review of the arithmetic found

**Status:** applied. `CALC_VERSION` raised to 2; every stored row from version 1 must be recomputed.
**Date:** 2026-09-05
**Follows:** [0002 — the profit engine](./0002-profit-engine.md)

---

Six independent lenses attacked the implemented engine, and each finding was then handed to a
separate agent whose job was to refute it — with a reproduction, not an argument.

Two things survived the attack cleanly, and they are the two that most needed to:

- **Every recorded expectation was arithmetically right.** One lens re-derived all eleven
  fixtures by hand, from the documented formula, *before* reading any engine source: revenue
  identity, COGS, rule matching with percent/fixed/clamp/fee-VAT and the VAT-recovery gate, COD
  on the captured leg, actual-versus-fallback shipping, every largest-remainder line share
  including tie-breaks, `marginBps`, business date, every confidence term and the exact
  diagnostic set. Zero disagreements.
- **The money kernel is correct everywhere it was attacked.** `mulBps` was checked against
  exact BigInt arithmetic over 1.27M value/rate pairs: no disagreements, no negative zeros, no
  spurious throws. `splitVatInclusive` holds `net + vat === gross` across 184,020 cases. The
  guard placement question has a clean answer — checking the *product* rather than the operands
  is sound, because any exact integer product at or above 2^53 rounds to a double that fails
  `Number.isSafeInteger`.

The defects were all on paths **no fixture reached**. That is the real lesson: `pnpm verify` was
green throughout, and mutation testing confirmed it — deleting the entire restock branch killed
zero of eleven fixtures.

## The two that were making money wrong

**A refund could increase profit.** A reversal with no line detail credited back the *entire*
order's COGS, regardless of how little was refunded — and `total` included shipping and goodwill
components, so a refund that returned no goods at all credited every SKU's cost. A SAR 110 refund
on a SAR 330 order left it *more* profitable than never refunding. Two such reversals produced a
120% contribution margin on a sale with positive COGS.

Now prorated by the item revenue actually reversed, keyed on `amountExVatMinor` alone (a
shipping or goodwill refund returns nothing), and capped per line at that line's own COGS. The
cap also closes a second defect: a reversal line claiming quantity 5 against a line ordered once
credited five times its cost, because the clamp that existed ten lines below was applied only to
the cosmetic `reversedQuantity` field and not to the one that moves money.

**`Σ(lines) === totals` broke** — the flagship invariant, asserted in four places including this
engine's own docstring. On any `cost_only` order carrying an unreflected shipping or COD-fee
discount (a free-shipping coupon on a refused COD parcel: a week-one shape), the totals and the
per-SKU numbers disagreed by exactly the discount, with no diagnostic. The cause was a second
source of truth — `computeRevenue` zeroed those discounts for a non-recognized order while the
orchestrator re-read them from `order.discounts`. They now come from one place, and the runner
asserts the revenue side of the tie, which is the assertion that was missing.

## The rest

| | Was | Now |
|---|---|---|
| Cost-only allocation | Every order-level cost split **evenly**, because recognition zeroed the weight — a SAR 10 accessory carried the same courier cost as a SAR 300 item, and was flagged a loss-maker at 220% of its revenue | Weighted on the item's own line total, which survives revenue zeroing |
| Split fulfilment | `shipment.lines` read nowhere; freight smeared by revenue, which is *anti*-correlated with it — a kettlebell in a heavy parcel reported +3.85% instead of −71% at basis `actual` | Each parcel's cost attributed to the lines that travelled in it |
| Return shipping | Split across every line, charging two SKUs the customer kept for a return leg they had nothing to do with | Weighted by what was actually returned; falls back to revenue share for an RTO, where the whole order came back |
| Unmatched reversal line | The refund silently **vanished** — byte-identical to having no reversal at all | Spread by revenue share and flagged; confidence drops to `allocated` |
| Paid order, no captured leg | Zero gateway fee, no diagnostic, confidence `exact` | Detected before the early return; basis `missing`, so the incomplete gate catches it |
| Settled carrier cost | Discarded whenever `fulfillmentMethod` was not `carrier` — SAR 21 of reported cost deleted | The method gates the *fallback*, not the sum |
| Unknown card scheme | The candidate filter reduced to `r.scheme !== r.scheme` — always false, so an instrument-agnostic catch-all could outbid the merchant's own card table by 3.4× | Candidates written out explicitly, compared within the most specific tier that applies |
| COD carrier | Taken from the lowest-*id* outbound shipment, with no status filter — a 2.5× error decided by a shipment id | Live outbound legs only; the collected cash is split across carriers and priced under each one's rule |
| A fractional rate | `2.75` meaning 2.75% gave a 100×-wrong fee on orders where the multiplication happened to land on an integer, and dead-lettered the rest | `mulBps` rejects a non-integer rate, and the whole rate card is validated up front under `FEE_RULE_INVALID` |
| A transposed floor and cap | The cap silently won, inventing SAR 199 of margin | Rejected as an invalid rule |
| `marginBps` | Could be negative zero, so `marginBps < 0` was false and a loss-maker query dropped the row | `toBps` normalizes it, as `toMinor` always did |
| Recognition | `authorized` was missing from the RTO set — one enum member away from the loss shape the whole model exists to catch, worth SAR 180 in the flattering direction. `voided` and `failed` booked full revenue outside a cancellation. A lost parcel reported a completed profitable order | All three handled; two new `cost_only` reasons, `payment_not_settled` and `goods_lost` |
| Cancelled before dispatch | Full COGS **plus** an invented courier charge for a parcel that never existed | No fallback for an undispatched cancellation, and stock that never left the shelf is credited back |
| Totality | Seven input shapes — `null`, `{}`, a missing `order` — escaped as an uncaught `TypeError` **from the handler that exists to prevent exactly that** | Identifiers read before the `try`; a structural gate returns `MALFORMED_INPUT` |
| Diagnostic naming | A malformed timestamp reported `INVALID_TIMEZONE`; a fractional quantity reported `NEGATIVE_QUANTITY` — telling a merchant their timezone is broken when their adapter's date formatting is | `MALFORMED_TIMESTAMP` and `NON_INTEGER_QUANTITY` |
| Confidence | `deriveConfidence` ignored its diagnostics argument, so a warning could coexist with `level: 'exact'` | Every diagnostic meaning "less trustworthy" now moves a term |
| `CALC_VERSION` guard | Grepped the changed-file *name list*, so rewording a comment satisfied it; and the merge base equals HEAD on a push to main, so it was a permanent no-op there | Reads the value and requires a strict rise; falls back to `HEAD~1` |

## Fixtures

Eleven to twenty-three. The twelve additions are exactly the shapes that let the above survive:
a cost-only order with a shipping coupon, a no-line-detail refund that restocked, a loss-maker
with non-zero revenue landing on an exact `.5` remainder (so the signed rounding branch actually
runs — `Math.round` gives −66 there where the correct answer is −67), a cancellation before
dispatch, split fulfilment with parcel mappings, a pickup order with a settled charge, an order
not yet shipped, a VAT-inclusive rate with a floor that bites, a partially costed order, an
unregistered merchant paying cash on delivery, an RTO whose return leg is still in transit, and
provider-keyed rate specificity.

190 tests, up from 103. Sixty of them are new totality tests: every hostile input the review
found is now a test asserting the engine does not throw.

## Still open

Three findings were confirmed but deliberately deferred, because they need a product decision or
a contracts change rather than a fix:

1. **A chargeback penalty has nowhere to go.** The real acquirer penalty in this market is
   SAR 75–150 on top of the retained original fee, and the only representable encoding reports it
   to the merchant as refunded *revenue*. `reversal.kind` is audit-only until a penalty term
   exists on `FeeRuleSet` and `OrderProfitTotals`.
2. **A platform-funded discount cannot be represented.** `OrderDiscount` has no axis for *who
   paid*, so a marketplace or bank-funded campaign understates merchant revenue by the full
   discount — during exactly the periods when volume spikes. The fix is a `fundedBy` field; it is
   a contracts change and a migration, so it should be decided rather than slipped in.
3. **An RTO's goods have no condition signal.** `RestockOutcome` lives only on
   `CanonicalReversal`, so a refused parcel that comes back crushed still credits its full cost.
   The inference is now reported and forces the COGS term to `estimated`, so such an order can
   never claim `exact` — but the honest fix is a condition field on `CanonicalShipment`.
