# 0002 — The profit engine

**Status:** implemented; corrected by [0003](./0003-engine-review.md), which is the current
state. 23 golden fixtures, 190 tests, `pnpm verify` green. `CALC_VERSION` is 2.
**Date:** 2026-09-05
**Follows:** [0001 — the canonical domain model](./0001-domain-model.md)

---

## The six open questions, now decided

All six were product calls rather than engineering ones. Each is settled below, with what
the code actually does about it.

**1. How merchants supply courier cost.** Ship the single blended per-shipment number at
onboarding; offer a per-region rate card later, from the shipping-cost drill-down where the
merchant is already looking at the number.

*In the code:* `ShippingFallbackRule` with every key `null` is a legitimate catch-all row, and
`matchShippingRule` scores geographic specificity so a later per-region row outranks it. Direction
is a filter rather than a score — a rule written for returns always beats one written for either,
which is what makes the upgrade path work for RTO rates too. No type change is needed to move
from one to the other; the fixtures use the blended form.

**2. An unknowable card scheme behind a wallet.** Assume the more expensive scheme, mark the
term estimated, and never flag a loss-maker on a fee-driven margin.

*In the code:* when a card leg's scheme is `null` or `'unknown'`, `computeGatewayFees` prices
**every** candidate rule for that instrument and provider and takes the **most expensive**,
emits `CARD_SCHEME_UNKNOWN`, and forces `confidence.gatewayFee` to `estimated`. Fixture
`0003` covers it: the wallet leg is priced at the international-credit rate, not the domestic
debit rate, a difference of 3.75× on that leg.

**3. Default gateway rates, or forced entry.** Ship defaults, clearly labelled as estimates
until the merchant confirms them.

*In the code:* `FeeFormula.source` drives the confidence term directly. `default_table` also
emits `FEE_RULE_DEFAULT_USED` so the dashboard has something specific to say. A merchant's own
rate card is `estimated` too — see below.

**4. How "estimated" is presented.** Present it as the normal state with a quiet provenance
line. The hard exception is enforced in the model, not left to the UI.

*In the code:* `actual` requires a settled figure — a courier's charge on the shipment, or a
processor's own statement. A rate the merchant typed in is `estimated` even when it is their
real contract, because it is a rule applied to an order rather than the amount that order was
actually charged. `confidence.level === 'incomplete'` is the hard gate: any `missing` term, and
the margin is a bound rather than a number. Fixture `0004` is the shape that matters — an order
with no cost data reports a 94% margin and `level: 'incomplete'`, so loss-maker ranking must
exclude it.

**5. The `customerRef` salt.** Per-store, held in a key manager and never in the database.
Platform customer ids are small sequential integers, so a global or absent salt is brute-forceable
end to end from a database dump. *No engine code — recorded for the ingestion layer.* Still worth
a lawyer's five minutes on whether PDPL permits retaining even a salted hash; the field is
`| null`, so dropping it costs only repeat-purchase counting.

**6. Merchants below the VAT registration threshold.** Yes, they are in scope.

*In the code:* `StoreProfitConfig.vatRegistered` decides whether the VAT on the fees this engine
computes — processor and COD — is a recoverable pass-through or a real cost. Courier cost is not
adjusted here; it arrives already on the correct basis, per the convention on
`CanonicalShipment.carrierCostMinor`. Fixture `0008` is an unregistered merchant:
the same order carries SAR 1.02 more cost than it would for a registered one, on a fee of SAR 6.78.

---

## What implementing it changed

Three things that only became visible once the arithmetic was written.

### On a return to origin the goods come back — so COGS is not a loss

Working fixture `0001` surfaced this immediately. A refused cash-on-delivery parcel with its
COGS counted as consumed reports a margin of −SAR 164 on a SAR 300 order. The truth is −SAR 44:
the two shipping legs. The merchant still has the item.

There is no `CanonicalReversal` to hang the recovery on, because no money moved — which is
exactly why the *returned shipment* is the evidence. `rtoGoodsRecovered` looks for a return leg
that has actually arrived; if it is still in transit, nothing is credited, because the goods may
come back damaged or not at all and overstating a loss is the survivable direction.

This does not contradict 0001's "an RTO is not a reversal". There is still no reversal record.
`restockedCogsMinor` means *goods came back*, which is true of both a restocked refund and an RTO.

### A line now carries every term of its own margin

`Σ(lines) === totals` cannot hold if order-level revenue reaches lines only through the margin,
because then a fixture reader cannot reconstruct a line from its own fields. `OrderProfitLine`
gained `allocatedShippingRevenueExVatMinor` and `allocatedCodFeeRevenueExVatMinor`, so:

```
contributionMargin = netRevenue + allocShippingRev + allocCodFeeRev
                   − cogs − allocOutbound − allocReturn − allocGateway − allocCod
                   + reversalImpact
```

`netRevenueExVatMinor` stays items-only, because that is what a merchant means by "revenue for
this SKU". Both readings survive.

### `confidence.revenue` lost a value it could never produce

`'derived'` would mean "an ex-VAT component was extracted from a gross figure rather than
reported" — adapter knowledge the canonical types carry no signal for. The engine could never set
it, and a permanently unreachable enum member is a lie about what the system knows. It is now
`'reported' | 'unreconciled'`. Adding it back, with the signal, is additive.

Smaller additions from the same exercise: `FeeRuleSet.currency` (rate cards are transcribed by
hand, and `CURRENCY_MISMATCH` already existed to catch it); and three diagnostics —
`PAYMENT_LEGS_UNDER_TOTAL`, `INVALID_TIMEZONE`, `INTERNAL_INVARIANT_VIOLATED`.

---

## How totality is actually guaranteed

`computeOrderProfit` promises it never throws. That promise cannot depend on every internal
invariant holding, so it does not: the orchestrator wraps the computation and converts an
unexpected throw into `status: 'rejected'` with `INTERNAL_INVARIANT_VIOLATED`.

The money kernel is therefore free to throw on impossible input rather than inventing a plausible
number for it — a sum that leaves the safe-integer range, an allocation across zero buckets, a
negative VAT rate. In a queue worker a thrown exception is indistinguishable from a transient
failure and gets retried forever; a rejected result is dead-lettered once.

## The money kernel

Five functions every merchant-visible number passes through.

- **`mulBps`** rounds half **away from zero**, not `Math.round`'s half-up. `Math.round(-1.5)` is
  `-1`, so a charge and its exact reversal would differ by one halala and every refunded order
  would leave a residue. Tested antisymmetric over 1,429 values across six rates — 8,574 pairs —
  and independently against exact BigInt arithmetic over 1.27M pairs during review.
- **`splitVatInclusive`** returns VAT as the **residual**, so `net + vat === gross` by
  construction rather than by luck. Tested over 3,000 consecutive gross amounts.
- **`allocateMinor`** is largest-remainder with BigInt intermediates. Naive
  proportional-with-drift-to-last produces a **negative** allocation for a small total over many
  equal lines — a phantom surcharge that flips a SKU's margin sign and fires a false loss-maker
  flag, which is a headline feature. Ties break on remainder, then weight, then key — never array
  index, so re-ingesting an order whose lines arrive in a different order yields identical
  per-SKU numbers. Tested across 400 generated shapes plus the specific 7-halala-over-10-lines
  case; when every weight is zero it splits evenly and still ties. (That branch is reached by a
  cost-only order, not by the 100%-discount one — its lines keep their gross value.)
- **`MAX_MINOR`** is exactly `floor(MAX_SAFE_INTEGER / 10_000)`, chosen so the intermediate in
  `value × bps` stays exact. Exceeding it throws rather than degrading silently.
- **`toMinor`** normalizes negative zero, because `JSON.stringify(-0)` is `"0"` while
  `Object.is(-0, 0)` is `false` — a fixture would fail with nothing visibly wrong on disk.

## The golden fixtures

`packages/core/test/fixtures/golden/<nnnn>-<name>/{input.json,expected.json}`, plain JSON,
integer minor units throughout. The five the brief demanded are `0001`, `0002`, `0003`, `0004`
and `0005`.

The expectations are generated (`UPDATE_GOLDEN=1 pnpm --filter @ghalla/core test`) and then
hand-checked. A regenerated expectation can only ever agree with the implementation, so the
runner **also** asserts, independently of the recorded files, what must be true of any
implementation: the revenue identity, the margin identity, the VAT-recovery identity, eight
`Σ(lines) === totals` ties — two of which are satisfied by construction, since those totals are
built by summing the lines — per-line margin reconstruction, `restockedCogs <= cogs`,
safe-integer and no-negative-zero on every money field, `level` as a projection of the terms,
determinism, and invariance to the order items and shipments arrive in.

`CALC_VERSION` is `2`. It was `1` for the first implementation; the corrections in
[0003](./0003-engine-review.md) changed the arithmetic, so every stored row from version 1 must
be recomputed. `scripts/check-calc-version.sh` fails CI when an existing expectation is
**modified** and the constant does not **rise** — it reads the value, not the file name.

## What comes next

1. `persistence` — Drizzle schema, SCD-2 cost history, the materialized `order_profit` rows and
   incremental dirty rollups.
2. `ingestion` — orchestration over the `webhook_events` queue against a fake in-memory adapter,
   tested end to end without touching a real platform. The queue is a Postgres table claimed with
   `FOR UPDATE SKIP LOCKED`, not Redis; see [0006](./0006-ingestion-queue.md) for why, and for the
   one condition that would change it.
3. The first real adapter, then the dashboard API and the Arabic RTL UI.
4. Then the scaffold for a second platform. If its stubs require changing anything in
   `packages/core`, this model is wrong — and that is still the cheapest moment to find out.
