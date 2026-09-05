# 0001 — The canonical domain model

**Status:** proposed, awaiting sign-off. Nothing downstream may be built on it until then.
**Date:** 2026-09-05
**Scope:** `packages/contracts`, `packages/ports`, `packages/schemas`, and the type surface of `packages/core`.

---

## What this is

Phase 1, step 1: get the domain model right in isolation, before persistence, before
ingestion, before an adapter. The profit arithmetic is deliberately **not implemented** —
every function body in `packages/core` throws `NotImplementedError`. The types are the
deliverable, because they are the thing that is expensive to change later: every adapter,
the database schema, and every materialized profit row follow from them.

The build, the lint suite, the boundary rules and the primitive tests all pass. What is
being asked for is agreement on the shapes.

## The seven decisions that matter

Everything else is detail. These seven are where the model departs from the obvious design,
and each one is a place where the obvious design produces a wrong number a merchant would
eventually catch.

### 1. A return to origin is not a refund

A cash-on-delivery parcel refused at the door moves **no money**, so no refund record exists
anywhere. A model that derives revenue from line totals and reverses it only through refunds
reports that order as **fully profitable** — when the truth is two shipping legs of pure loss.

For the COD segment, which is most of the Saudi market, that is not an edge case. RTO impact
is a named Phase 1 deliverable, and it is unimplementable without this.

The fix is three orthogonal status axes on the order — `lifecycle`, `paymentState`,
`fulfillmentState` — plus a `recognition` discriminant on the result that marks an order
`cost_only`: costs count, revenue is zero, and it stays out of revenue and average-order-value
denominators. Return shipping is lifted out of the refund term into `returnShippingCostMinor`,
where an RTO can reach it.

### 2. A wallet is not a payment method

`method: card | mada | applepay | …` is a category error: it makes a card network (`mada`)
and a presentment wrapper (`applepay`) peers of a rail (`card`). Payment processors model
these as independent fields precisely because they are independent.

The cost is not cosmetic. A single "Apple Pay" fee rule is wrong by roughly **3×** depending
on whether the card behind it was domestic debit or an international credit card — and in a
high-iPhone-share market that is a large fraction of card orders. The discarded axis is not
recoverable from stored data, so this is the single most expensive field in the model to get
wrong.

`PaymentBreakdown` therefore carries `instrument` / `scheme` / `wallet` / `provider`
separately, plus `state` (an uncaptured leg must not accrue a fee) and `transactionRef` (the
only future join key to a settlement line).

### 3. Money is a branded integer, and the brand is the enforcement

"No floats for money" as a rule is a code-review convention. `Minor = Brand<number, 'Minor'>`
with `toMinor` as the only constructor makes a bare `number` **structurally unassignable** to
a money field — verified: assigning `1500` to a `Minor` is a compile error, and so is passing
a `StoreId` where an `OrderId` is expected.

`number`, not `bigint`: `JSON.stringify` throws on bigint, and the golden-fixture harness that
will guard the engine is entirely JSON. The real hazard is not magnitude but the intermediate
in `amount × bps`, so `MAX_MINOR` is set to keep that product inside the safe-integer range,
and exceeding it throws rather than degrading silently.

`toMinorFromDecimal` parses digit-wise. `parseFloat('1.005') * 100` is `100.49999999999999`,
which rounds down and shorts the merchant a halala on every order — there is a test for it.

### 4. Confidence is per-term, and `missing` is not `estimated`

A flat `exact | estimated_cost | estimated_fee | estimated_both` is a flattened 2×2 over what
are already six independent axes, and it has no member for *absent*.

That gap is the day-one state of every install: cost history entered at signup has a validity
window that starts after every backfilled order was placed. A missing cost contributes **zero**
to COGS, so an uncosted SKU reports as the most profitable product in the catalogue — in
loss-maker flagging, the exact feature where being wrong is worst.

So: a per-term `ProfitConfidence` record, a derived `level`, and a hard rule that
`level === 'incomplete'` rows are excluded from loss-maker ranking. That gate is what keeps
`estimated` honest — *estimated* means we used your rate card, *incomplete* means we are
guessing at zero.

There is a second reason the flat enum fails in production: neither platform in scope exposes
courier cost or gateway fees anywhere, so every order would land on the same value while the
merchant's remedy differs completely by component.

### 5. The engine is total, and never throws

Webhooks are queued and ingestion owns retry, so a throw is indistinguishable from a transient
failure: a permanently uncosted SKU becomes a deterministic retry storm that also delays
healthy jobs, and the order disappears from the dashboard entirely.

`computeOrderProfit` returns `OrderProfitComputed | OrderProfitRejected`. `rejected` is reserved
for defects in the *caller* — currency mismatch, an orphaned item, non-integer money, two cost
rows for one product key — and is a machine-readable dead-letter signal that, unlike an
exception, is snapshot-testable in a golden fixture.

Everything a merchant can act on is a `Diagnostic` on a computed result. Those are not
telemetry: "no cost recorded for this SKU" is the call to action that drives cost entry, which
is the product's activation loop.

`Result`/`Either` was rejected for a different reason — it collapses partial success. An order
with nine costed lines and one uncosted is 90% useful.

### 6. One fetch method, not three

The brief requires that the platform fan-out be invisible to ingestion, and then lists the
fan-out as three port methods. With three, *ingestion* is the thing sequencing them — it has
to know one platform needs the order before it can address the shipments, and it changes shape
when the second adapter lands.

`fetchOrderBundle` returns order + items + shipments + reversals in one call, with a `partial[]`
listing what the adapter could not retrieve. That is strictly better than the split: the retry
decision is made with adapter knowledge and executed by ingestion's scheduler, and *"no
shipments exist"* stops being indistinguishable from *"shipments could not be fetched"* — which
otherwise produces a confidently wrong number.

A narrow `fetchShipments` survives, because shipment webhooks are an independent caller and it
is how a partial bundle is retried.

### 7. PII is impossible, not forbidden

`AssertNoPii<T>` is a compile-time deny-list over the *keys* of every canonical type, asserted
for all thirteen of them in `pii-audit.ts`. A field that cannot be declared cannot be mapped,
cannot be persisted, and cannot leak. It is why `CanonicalOrderItem` carries `productName`
rather than `name`.

The raw payload — where the forbidden data actually lives — is not a field on the canonical
types at all. `Ingested<T>` wraps them and is published only at `@ghalla/contracts/ingest`, a
specifier that both ESLint and dependency-cruiser forbid `core` and `persistence` from
importing. `Ingested<T>` is not assignable to `T`, so `{ ...canonical, raw }` cannot
reconstitute it.

`trackingNumber` is on the deny-list, because a waybill number resolves to a delivery address
on a carrier's public site. The consequence is deliberate: a future carrier-invoice import must
reconcile on `platformShipmentId`.

---

## Everything that differs from the brief

| # | Brief | This model | Why |
|---|---|---|---|
| 1 | `CanonicalRefund(amount, isFullReturn, restocked)` | `CanonicalReversal` with an id, `kind` (refund/void/chargeback), `reason`, per-line detail, and a five-way ex-VAT split | A gross scalar cannot yield an ex-VAT reversal (15% wrong on every refund); no line detail means per-SKU margin is permanently wrong after any partial return; a void's fee was never incurred and must not be sunk; no id means a redelivered webhook subtracts twice |
| 2 | `status` | `lifecycle` + `paymentState` + `fulfillmentState` + `rawStatusLabel` | Decision 1. Also: "shipped" and "refunded" are not exclusive, and merchants define custom statuses |
| 3 | `method` enum | `instrument`/`scheme`/`wallet`/`provider`/`state`/`amountGrossMinor`/`transactionRef` | Decision 2 |
| 4 | 4-value `confidence` | Per-term record + derived `level` + diagnostics | Decision 4 |
| 5 | `config.codHandlingCostMinor` | `CodFeeRule`, keyed by carrier, percent + fixed with min/max | Couriers quote a fixed amount *plus* a percentage, and it differs per carrier within one store. A constant diverges without bound, in the flattering direction |
| 6 | `gateway_fee = amount × bps + fixed` | Adds a min/max clamp and a VAT split gated on `vatRegistered` | Domestic debit is capped per transaction; Saudi VAT law taxes the fee itself, so the brief understates gateway cost by 15% on every card order |
| 7 | `contracts` = types **+ zod**, zero deps | `@ghalla/contracts` (zero deps) + `@ghalla/schemas` (zod) | Self-contradictory as written. A validator in contracts sits in the engine's dependency graph. Cost: every type declared twice, bound by `DriftAudit` so divergence is a build error |
| 8 | `fetchOrder` / `fetchOrderItems` / `fetchShipments` | `fetchOrderBundle` + narrow `fetchShipments`; added `fetchStore`, `revokeCredentials`, `fetchVariants` | Decision 6. `fetchStore` was a hole — `CanonicalStore` is in the brief and nothing produced it |
| 9 | `verifyWebhook(headers, rawBody, secret) → boolean` | `verifyWebhook(delivery, secret) → WebhookVerification` | `Buffer`/DOM `Headers` do not exist under `"types": []`; a string body permits a re-serialization before the HMAC (a live risk with Arabic names); a boolean cannot carry the tenant key or distinguish a bad signature from clock skew |
| 10 | `StoreCredentials` with access/refresh tokens | `PlatformCredentials` with absolute instants and an opaque `SecretBag` | One platform issues three secrets and sends the same value under two header names. One reports expiry as a duration from one endpoint and an epoch from another, under the same field name |
| 11 | `Attribution` with five UTM fields | `{ device, referrerHost }` | The platforms carry no UTM data, ad spend is out of scope, and five permanently-null columns read as an ingestion bug. Re-adding is purely additive. The referrer is truncated to host for privacy |
| 12 | "money is integer minor units" (a rule) | Branded `Minor` with checked constructors; branded `Instant`/`LocalDate`/`Bps`/ids | Decision 3 |
| 13 | canonical types carry `raw` at the boundary | `Ingested<T>` at a separate entry point, plus the PII key deny-list | Decision 7 |
| 14 | returns margin + confidence | Full totals breakdown, per-line array, `recognition`, `businessDate`, `feeRuleSetId`, diagnostics | Per-SKU profit has no home otherwise, and computing it outside the engine duplicates the allocator — after which order profit and the sum of its SKU profits stop matching |
| 15 | `vatRate`, `shippingChargedToCustomer`, `total` | `vatRateBps` + `vatRegistered`; every money field named for its VAT basis; added `destination`, `customerRef`, `fulfillmentMethod` | A 0.15 float in a codebase that bans floats for money; `vatAmount`'s scope was undefined, and read as goods-only no order reconciles; `destination` is the shipping fallback's only input and did not exist; `customerRef` is mandated by the privacy section and had no field; `fulfillmentMethod` stops the fallback inventing a courier charge for a pickup order |
| 16 | `Platform` enum | `PlatformId` as an opaque brand; carrier/provider/wallet as open slugs | A union would put platform vocabulary in the shared layer. Enforced by a CI grep, since this is a rule about strings, not modules |
| 17 | `BillingAdapter.parseBillingWebhook` | Adds `verifyBillingWebhook` | As specified the billing endpoint is unauthenticated: anyone who learns the URL can grant themselves a subscription |

Two smaller additions worth flagging: `OrderDiscount.reflectedInComponent`, which makes
double-counting unrepresentable (as written, an order-level coupon either inflates revenue by
its full value or deflates it by the same amount, and nothing in the types said which); and
`CanonicalShipment.id` plus `CanonicalOrderItem.platformLineId`, without which re-ingestion
double-counts the largest cost line and per-SKU allocation churns between recomputes.

---

## Open questions for you

None of these block writing the types. All six are product calls, not engineering ones.

1. **Courier cost is merchant-supplied, not platform-supplied.** Neither platform exposes what
   the courier actually billed. The zone rate card is not a fallback — it is the primary
   mechanism for essentially every order. How do merchants supply it: a per-region rate-card
   screen, a CSV of their contract, or one blended per-shipment number?
   *Recommendation:* ship the one-number path so nobody stalls at onboarding, then offer the
   per-region screen from the shipping-cost drill-down. `ShippingFallbackRule` supports all
   three with no type change — a row with every key `null` **is** the blended case.

2. **An Apple Pay order's underlying card scheme is not knowable** on at least one platform,
   and that is a ~3× fee difference.
   *Recommendation:* assume the more expensive scheme, stamp `confidence.gatewayFee` as
   estimated, and never flag a loss-maker on a fee-driven margin. Understating a merchant's
   profit and being corrected is survivable; overstating it and being caught is not.

3. **Gateway rates are privately negotiated.** Ship opinionated defaults, or force explicit
   entry?
   *Recommendation:* ship defaults clearly labelled as estimates until confirmed —
   `FeeFormula.source` already distinguishes them and feeds the confidence term. The real
   decision is how loudly the dashboard says "these are our estimates, confirm them", and it
   should be loud.

4. **Essentially every order will be `estimated` on shipping and gateway fee.** Is that
   acceptable for a product whose tagline is *know your real profit*, and how is it presented?
   *Recommendation:* present estimated as the normal state with a quiet provenance line — a
   merchant's own flat-rate contract genuinely *is* accurate. The hard exception is already in
   the model: `level === 'incomplete'` must never be shown as a margin. Worth writing the
   Arabic copy for both states before the dashboard is designed.

5. **Is the `customerRef` salt per-store or global?**
   *Recommendation:* per-store, held outside the database. Platform customer ids are small
   sequential integers, so a global or absent salt is brute-forceable end to end from a
   database dump. Also worth five minutes of legal advice on whether PDPL permits retaining
   even a salted hash without consent — the field is already `| null`, so dropping it costs
   only repeat-purchase counting.

6. **Do we target merchants below the mandatory VAT-registration threshold?** They cannot
   reclaim input VAT, so the 15% on their courier and gateway invoices is a real cost.
   *Recommendation:* yes. `vatRegistered` is one onboarding question, and getting it wrong is
   roughly 15% of two cost lines — which lands right on the loss-maker threshold.

---

## What was verified, not assumed

- **Branding bites.** Assigning `1500` to a `Minor`, or a `StoreId` to an `OrderId`, are
  compile errors. Confirmed against the real compiler, not asserted.
- **The boundary holds at four layers.** A file planted in `packages/core` importing a
  persistence SDK, a Node builtin, `@ghalla/ports`, `@ghalla/contracts/ingest`, and using
  `new Date`, `Math.random`, `Math.round`, `parseFloat`, `.toFixed` and `process.env`
  produced **11 ESLint errors**, **5 TypeScript errors**, and **7 dependency-cruiser errors**.
  It was then deleted.
- **Two holes were found and closed by doing that.** `@ghalla/*` does not cross a slash, so
  `@ghalla/contracts/ingest` — the one specifier that must not reach the engine — walked
  straight through the first version of the rule. And `/dist/` in dependency-cruiser's
  `exclude` made every cross-package edge invisible, silently disarming the rules that depend
  on them.
- **The drift audit works.** It caught a real mistake while being written: `CanonicalStore.platform`
  is a branded `PlatformId` and the schema had declared a plain string.
- **The vocabulary guard fires.** A planted `'salla'` string under `packages/` fails CI.
- **31 primitive tests pass**, including the `1.005` case that defeats `parseFloat` and the
  full leap-year rule that `new Date()` would silently roll over.

One thing learned by building rather than designing: a module-private `unique symbol` brand
**cannot be named across a package boundary**, so a dependent package that lets a branded type
be inferred into an exported declaration fails with TS4023. The fix is to annotate that export
with the named alias rather than to weaken the brand — `@ghalla/schemas` annotates its
primitive schemas for exactly this reason, and the constraint is documented in `brand.ts`.

## What comes next, once this is agreed

1. Implement the money kernel — `allocateMinor` (largest remainder) and `mulBps`
   (half away from zero) are the two that decide whether per-SKU profit ties to order profit.
2. Implement `computeOrderProfit` against golden fixtures: a full COD return with two shipping
   legs and zero revenue, a partial refund, a multi-payment-method order, an order with no cost
   data, and a 100% discount order.
3. Only then `persistence`, `ingestion` with an in-memory fake adapter, and the first real
   adapter.

Step 6 of the build order — scaffolding the second adapter — is the real test. If implementing
its stubs requires changing anything in `packages/core`, this model is wrong and it is still
cheap to fix.
