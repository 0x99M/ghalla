# 0008 — Billing, entitlements and usage

**Status:** subscription state, entitlements and metering are implemented. The
guard is built and NOT wired to any controller; the Salla adapter and the
dashboard API are the remaining pieces.

Three concerns, kept apart deliberately, because merging them is the reliable
way this becomes unmaintainable:

| | Question | Lives in |
|---|---|---|
| Subscription | what plan is this store on, right now | `store_subscription`, `billing/subscription.ts` |
| Entitlements | what does that plan permit | `billing/plans.ts`, `billing/entitlements.ts` |
| Usage | how much of the allowance is gone | `billing/usage.ts`, derived from `orders` |

`@ghalla/billing` is pure and platform-neutral, like `core`: no I/O, no clock,
no platform vocabulary. Every function that needs the time takes it as an
argument, because every interesting case in billing is a boundary and a function
reading the wall clock cannot be tested at one.

## Two departures from the brief

**No Redis for the usage cache.** The brief specifies Redis with a 5-minute TTL
and explicit invalidation on plan change. We run no Redis — see
[0006](./0006-ingestion-queue.md) — and adding it here would mean a second
stateful system for a number that, by the brief's own account, "drives a banner,
not per-request enforcement, so staleness is harmless".

So the cache is in-process with the same TTL, behind `UsageCache`, and the
invalidation requirement is met by the KEY rather than by an invalidation call:

- the key is `usage:{store_id}:{period_start}`, so a renewal starts a fresh
  count and the old key simply ages out;
- the PLAN is deliberately not in the key, because the cached number is the
  order COUNT and a plan change does not affect it — only the cap does, and the
  cap is read from the subscription row on every request.

A merchant who upgrades mid-period therefore sees the new cap **on the next page
load**, with nothing invalidated and no message bus needed to tell other
replicas. That is strictly better than explicit invalidation in a multi-replica
deployment without a shared cache, and it is tested.

What this must not become is the thing a limit is *enforced* from. If usage ever
gates an action rather than decorating a page, it has to move to a shared store
first — and by then the queue's own trigger condition has probably fired too.

**`ingestion_source` was not in Phase 1.** The brief anticipated this and it was
right: it is added here, in `0002_billing`, defaulting to `live`. That default is
the safe direction — a backfill that forgets to set the column over-counts and
gets noticed, where defaulting to `backfill` would silently meter nothing at all.

## Subscription state

Four rules, all load-bearing.

**The local table is the source of truth for request handling.** No request path
calls the platform to check entitlement. It puts a network round trip on every
page load and makes a third party's outage into ours, at the exact moment a
merchant is trying to look at the dashboard they pay for. The platform is
consulted on two paths only, both off the request path: a webhook arriving, and
the nightly reconciler.

**Webhook-fed, through the Phase 1 ingestion edge.** Verify signature, persist to
`webhook_events`, return 200, process on the queue. A platform that does not get
its 200 quickly retries, and a handler doing database work inline turns one slow
query into a redelivery storm.

**Stale events are dropped.** `last_event_at` holds the occurrence time — the
platform's clock, not ours; ordering by arrival orders events by our own queue's
behaviour, which is the thing being defended against. The comparison is `<=`,
not `<`: two events stamped the same instant cannot be ordered by their
timestamps, so applying the second is a coin flip and one face of that coin
revokes a paying merchant's access. Refusing both is the safe half, because the
reconciler repairs a missed change and nothing repairs a wrongly-revoked one
except a support ticket.

This also makes redelivery idempotent for free: the first application advances
`last_event_at` to the event's own instant, so the second copy compares equal
and falls to the same guard.

**Reconciled nightly, at 03:00 UTC** — 06:00 in Riyadh, the quietest hour for
these merchants and well clear of midnight, where period rollovers and
business-date bucketing both happen. Reconciliation is the one path allowed to
move state backwards: a webhook is a claim about a moment, a reconciliation is
the platform's current answer. It does **not** advance `last_event_at`, because
that field orders webhooks against each other and stamping it here would make a
nightly pass silently discard the next genuine webhook older than it.

The correction count is the metric that matters, and its value is entirely in
being normally zero. A rising count means the webhook path above it has a hole.

## Entitlements

Plans live in code. A plan is a product decision and belongs in a reviewable diff
beside the deploy that introduced it, not in an UPDATE somebody ran at 11pm.

The consequence is deliberate: `plan_code` carries **no CHECK and no foreign
key**. Constraining it would put the plan list back in the database through the
back door and make adding a tier a migration again. `status` is the opposite
case — a fixed lifecycle, checked against the same frozen tuple the code reads
it back with.

Grandfathering is a naming rule and it is the only thing keeping this honest:
when a plan's contents change, add a new code. `growth` stays `growth`. Editing
an entry would silently re-price every existing subscriber.

An unknown plan code **fails closed** — `core` only, starter's cap — and is
surfaced as a metric. Failing open would make "write a plan code nobody
recognises" a way to obtain the top tier.

Resolution happens once per request, in `EntitlementsGuard`, onto the request
context. A denial is a **402** carrying the feature, the current plan and the
cheapest plan that includes it, so the frontend renders a targeted upgrade
prompt. 402 rather than 403 because the distinction is real: 403 means "not for
you" and prompts a support ticket, 402 means "not yet" and prompts a checkout.

## Behaviour at limits

**Degrade the interface, never the data.** A data gap is permanent — nobody can
re-ingest the orders that arrived while a card was declining. A locked screen
reverses the instant they pay. The asymmetry is not generosity, it is the
cheaper mistake.

`canceled` is the only state that stops the pipeline, and only because the
merchant has asked us to stop. Export survives every state, for the whole
retention window: a merchant who can leave with their data is more likely to
come back, and one who cannot will say so publicly.

`past_due` reads as active everywhere. Payment retries frequently succeed, and
cutting someone off over a card that expired on Tuesday — when the bank will
authorise on Thursday — turns a billing hiccup into a churn event.

## Plan changes: immediate up, deferred down

Confirmed with the platform, and the two directions are NOT symmetric.

**Upgrades are immediate and prorated.** The unused remainder of the current
cycle is credited against the new plan and the difference is charged on the
spot. The merchant expects the features on the next page load, not at the next
monthly anchor — provisioning late is the most visible way to make a paid
upgrade feel broken, because they have the receipt and not the feature. Nothing
special is needed for this: the webhook carries the new plan and `applyChange`
applies it.

The platform may either preserve the original renewal date or start a fresh
30-day cycle on the upgrade date. Either is fine, because the period comes from
the event — and the usage cache keys on `period_start`, so a reset begins a
fresh count with nothing to invalidate.

**Downgrades are deferred to the end of the paid cycle.** There is no partial
refund, so the merchant has bought the higher tier through to the end of the
period and must keep it. `pending_plan_code` and `pending_plan_effective_at`
hold the agreed change; `effectivePlanCode` applies it at READ time.

Read time, not a job: a cron that has to fire at the exact second a period rolls
over is a cron that will one day not fire, and the merchant then keeps a tier
they stopped paying for — or, with the timing reversed, loses one they still
own. The row catches up on its own when the renewal webhook arrives, and the
reconciler writes it down if that webhook never does.

The comparison that decides which case applies is about ENTITLEMENTS, not price:
losing a feature is a downgrade whatever the cap does, and caps are normalised
to a monthly rate first so that a switch between monthly and annual on the same
tier is correctly seen as neither.

One bug worth recording, because the test found it and review would not have:
the deferral originally measured against the period the EVENT carried. A renewal
onto a lower plan arrives carrying the next window, so the change looked "early"
against a boundary that moved every time it was deferred — the downgrade would
have been postponed forever and the merchant would have kept the higher tier for
good. The boundary is the period already paid for, which is the one on the row.

## Annual

Two months free: pay for ten, get twelve. It reduces churn through the fragile
first year — the period before a merchant has entered enough cost data to see
what the product is for — and pulls cash forward.

Annual plans are their own codes (`growth_annual`), never a flag on the monthly
one, by the same grandfathering rule. Their caps are scaled by twelve so the
allowance PER MONTH is unchanged: an annual plan buys a longer period, never a
smaller rate. A `growth_annual` whose cap stayed at 1,500 would be a twelvefold
cut disguised as a discount, and the merchant would hit it in January.

The price is not here. The platform charges the merchant and is the only place
an amount is authoritative; duplicating it would create two numbers that can
disagree about what somebody owes.

An upgrade prompt never offers annual. A merchant hitting a locked feature is
deciding in the moment, and a twelve-month commitment is a bigger ask than the
feature is worth to them right then — annual is what you offer someone who has
already stayed.

## Asking the platform: one path, three triggers

`SubscriptionRefreshService.refreshNow` is the only code that fetches the
platform's answer for a store and writes it down. Three callers use it:

| Trigger | Why |
|---|---|
| Install handshake | A store whose first billing webhook was lost would otherwise sit on a provisional trial for ever — nothing else creates its row, because the sweep only walks rows that exist. |
| Merchant refresh | Self-service answer to "I upgraded, where is my feature". |
| Nightly sweep | Drift repair. |

Three implementations of "ask the platform and reconcile" would drift, and the
drift would surface as *the reconciler says one thing and the install said
another* on stores nobody can reproduce.

**The merchant refresh never blocks.** `requestRefresh` marks the store due in
the database — the row IS the queue, so the request survives this process
dying and the nightly sweep is the safety net — then starts the fetch detached
and returns. A dashboard that hangs while we talk to a third party is exactly
what the local-table-is-truth rule exists to prevent, and a synchronous
"lazy reconciliation" on the request path would reintroduce it.

It is throttled to one fetch per store per minute, using `last_reconciled_at`
itself rather than a separate timer: durable, shared across replicas, no new
state. Holding the button down must not become a way to earn a rate-limit ban
for every other store. Concurrent refreshes for one store collapse into a single
call, so a double-click cannot produce two writes that land out of order.

The detached promise carries no `.catch`. `refreshNow` is total — every failure,
including one thrown synchronously by the source, becomes a `failed` result —
and that totality is asserted by a test rather than guarded by a catch block
that could never fire.

## What is deliberately not wired

`EntitlementsGuard` is provided by `BillingModule` but not registered globally,
and no controller carries `@RequiresFeature` — there is nothing store-scoped to
gate until the dashboard API exists, and a global guard would start resolving
entitlements for the healthcheck.

`SUBSCRIPTION_SOURCE` is unbound. Every caller reports `unavailable` and the
sweep logs *"checked nothing; is a subscription source wired?"* rather than
returning a clean zero — a component that silently does nothing is
indistinguishable from one that found nothing wrong, and those are opposite
situations.

A `NoopSubscriptionSource` returning `null` per store was considered and
rejected for the same reason, only worse: `null` means "the platform does not
recognise this store", which stamps `last_reconciled_at` on every store every
night. The freshest signal that reconciliation is broken is that column, and a
Noop would keep it permanently green.

## The Salla adapter, when it lands

Three pieces, and only the first is unknown:

1. **`getSubscription`** against Salla's app-subscription endpoint. The exact
   URL needs confirming against current partner docs — an endpoint copied from
   memory and wrong is a reconciler that fails silently every night, which is
   the failure this whole thing exists to prevent.
2. **Credentials lookup** keyed by our store id, reading `platform_credentials`
   (which already handles the encrypted blob, key rotation, and
   `reauth_required_at` so a dead token is not retried into a rate-limit ban).
   This lives on our side of the port on purpose: the adapter cannot resolve our
   identifiers.
3. **A plan map**, `platform plan id → PlanCode`, inside the adapter. Unmapped
   ids send `planCode: null`, which means "did not say" and preserves the last
   good plan rather than writing a code no build can resolve.
