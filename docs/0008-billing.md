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

## Open questions for the platform

- **Proration.** Whether mid-cycle upgrades are prorated or deferred to renewal
  needs confirming with Salla partners support, and it sets the timing of the
  upgrade prompt. Phase 2 monetization depends on existing merchants moving up a
  tier, so this is worth an email rather than an assumption.
- **Annual at two months free** is decided but not implemented; it needs plan
  codes of its own (`growth_annual`, not a flag on `growth`, by the naming rule
  above).

## What is deliberately not wired

`EntitlementsGuard` is provided by `BillingModule` but not registered globally,
and no controller carries `@RequiresFeature` — there is nothing store-scoped to
gate until the dashboard API exists, and a global guard would start resolving
entitlements for the healthcheck.

`SUBSCRIPTION_SOURCE` is unbound, so the reconciler logs and skips rather than
reporting no drift. A reconciler that silently does nothing is indistinguishable
from one that found nothing wrong, and those are opposite situations.
