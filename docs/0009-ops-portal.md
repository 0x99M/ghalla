# 0009 — Ghalla Ops, the internal operator portal

**Status:** steps 1–4 are built — the portal schema and its migration, the
`PlatformRegistry` and the read-only role, authentication, `lib/queries` with
every derived metric, and the read API routes with unstyled scaffold pages. The
snapshot job (5), the remaining alert types (6) and admin action proxying (7)
are next.

Prices are now set — see [0008](./0008-billing.md) — and they live in `PLANS`
rather than in a map of their own, asserted against the platform's own catalog
at startup and hourly. The portal reads them through `annualisedPrice`.

A separate Railway service, reading every integration database at once. Each
integration is its own service with its own Postgres, so a cross-platform
question is a fan-out and a merge — never a join, because there is nothing to
join across.

## Six decisions that differ from the brief

Five are consequences of decisions this repository already made. One is the
user's own instruction overriding the brief it arrived with.

### Drizzle, not Prisma

The brief says Prisma, and the rest of this repository is Drizzle. The deciding
argument is the brief's own rule — *generate one client per integration database
from the EXISTING integration schema; do not redefine those models*. Prisma
cannot do that. `prisma db pull` produces a second definition of tables that
Drizzle owns, and the two drift the first time a migration lands without a
re-introspection: the portal then queries a column that moved, or misses one
that arrived, and nothing fails until a number is quietly wrong.

Drizzle can do exactly what the brief asks. `@ghalla/persistence/schema` is not
a copy of the integration schema, it **is** the integration schema — the same
file the integration service migrates from. A column rename is a type error in
the portal on the next build.

### Auth is a single environment key

The brief specifies GitHub OAuth restricted to one account, or email plus TOTP.
The instruction that arrived with it says the opposite and is more recent: one
secret in an environment variable, a single field to enter it, nothing else
reachable without it.

It has one property worth stating plainly, because it shows up in this
schema: **there is no identity.** `admin_action_log.actor_session` and
`alert_ack.actor_session` are named for what they can actually hold — a session
fingerprint, not a person. With one shared key, "who ran the backfill" is not a
question the portal can answer, and columns called `actor` would have implied it
could.

For one operator that is a fair trade. It stops being one the day a second
person has the key, and the honest signal that the day has come is somebody
asking who did something.

Five decisions inside it are worth recording:

**The session signing key is derived from the access key.** That makes rotation
and revocation the same act: change the variable, and every outstanding cookie
stops verifying at the moment the old key stops being accepted. A separate
session secret would leave every stolen cookie working until it expired on its
own.

**32 characters, enforced at startup.** This is the load-bearing control, not
the rate limiter. No limit turns a feasible brute force into an infeasible one
or the reverse; length does. A portal holding every merchant's business data
does not start behind a memorable string, and a failed deploy is the better
outcome.

**Web Crypto, not `node:crypto`.** The same code runs in middleware, which may
execute on a runtime where the Node module does not exist. One implementation
across both beats two that can disagree about whether a token is valid — a
disagreement whose two failure modes are "locked out" and "let in".

**Two rate-limit tiers.** Per source at five failures, globally at twenty. The
global one exists because a single shared secret makes the source irrelevant to
an attacker who can change addresses; it is also the tier that could lock the
operator out, which is why its block is a minute rather than an hour.

**The middleware strips `x-ops-session` before stamping it.** The verified
session reaches routes as a request header so nothing verifies twice. Deleting
it first — unconditionally, on public paths too — is what stops a client sending
one and choosing what the audit log records.

### Liveness and ingestion health are different endpoints

`/api/live` is what Railway calls, so it cannot require a session — and
therefore answers with a status word and a timestamp and nothing else. A body
naming platforms and quoting connection errors would tell an unauthenticated
caller which integrations exist, which are down, and occasionally part of a
connection string. The detail an operator wants is in `/api/overview`, behind
the key.

`/api/health?range=` is the brief's route and a different question: how
ingestion has been going over a window. Overloading one path with both meanings
is how a health check ends up either leaking or failing deploys.

### No Redis

The brief caches `/api/overview` and `/api/revenue` in Redis for 60s with a
manual refresh that busts the key. We run no Redis — see
[0006](./0006-ingestion-queue.md) — and the portal is one operator on one
service, which is the case where a shared cache buys least.

So the cache is in-process with the same TTL, and `capturedAt` rides in every
payload as the design's "last updated". The refresh button busts the local
cache. If the portal is ever scaled past one instance, refresh clears one
instance's copy and the other expires 60 seconds later — which is a real
limitation, and a tolerable one for a 60-second TTL over an internal dashboard.

### `webhook_success_rate` is stored as two counts

The brief's `platform_snapshot` carries a rate. This schema carries
`webhooks_processed_24h` and `webhooks_failed_24h` instead, for the same reason
`order_profit` keeps `cost_covered_revenue_ex_vat_minor` and refuses to store a
ratio: **ratios do not aggregate.** A stored percentage cannot be combined across
platforms without re-weighting it, and the rollup that forgets to re-weight is
wrong in a way no test catches. `store_snapshot` does the same with coverage.

The ratio is still what gets displayed. It is derived on read, once, in
`lib/queries`.

### Money is `numeric(14, 2)`

The brief says integer minor units. The repository's convention is integer
halalas in the domain and `numeric(14, 2)` in Postgres with one codec between —
`_minor` column names included. The portal follows the integration schema
exactly, because a second set of habits in a second database is how two halves
of one system start disagreeing about a number.

### Prices live in `PLANS`, checked against the platform

`plans.ts` originally refused to hold prices, on the grounds that the platform
is the only authoritative source. The premise was right and the conclusion was
wrong — see [0008](./0008-billing.md). Prices are in the plan entries now,
beside the cap and the features, and `comparePlanCatalog` asserts them equal to
what the platform has configured.

What the portal produces is still **list MRR**: what these subscriptions bill at
list price, ignoring discounts, proration, tax and failed collection. That label
has to survive onto the screen, because an operator who reads it as revenue will
be wrong by whatever those add up to.

Every known plan now has a price, so the only way a subscription leaves the
total is a plan code this build does not recognise — a rollback to an older
image, or a plan published after this deploy. The MRR query reports those as
`unknownPlans` rather than dropping them, because a silent exclusion looks
exactly like a fall in MRR that nobody can account for.

## Three metrics need data no integration records yet

Not objections — the definitions are right. The inputs do not exist, and
inventing them would be worse than saying so.

| Metric | Missing input | What it needs |
|---|---|---|
| **Activated** | "at least one dashboard session" | Nothing records that a merchant opened the dashboard. One column, `stores.last_dashboard_seen_at`, written by the integration on a session. |
| **Webhook signature failures** | a rejected delivery | Verification happens *before* persistence, by design — an unverified payload is attacker-controlled and full of PII, so it is refused at the edge and never written. Counting these needs a deliberate `webhook_rejection(claimed_store_id, reason, received_at)` with **no payload**. |
| **Admin actions** | the admin API | `ghalla-salla` has no webhook controller, no recompute and no backfill yet. There is nothing to proxy to. |

Until each lands, the query reports the fact rather than guessing. `activated`
is `null` while an input is unknown, not `false` — a store that cannot be
assessed is not a store that failed.

## What the portal may see

Column-level grants, in [`apps/ghalla-ops/sql/ghalla_ops_ro.sql`](../apps/ghalla-ops/sql/ghalla_ops_ro.sql),
and the reasoning for each exclusion is in the file. The shape of it:

- **`orders`** — provenance and lifecycle only. Every money column is excluded
  (economics come from `order_profit`), and so is every PDPL-retained column:
  `customer_ref`, the destination fields, the attribution fields. Those exist
  for the shipping fallback, and the portal is not the shipping fallback.
- **`webhook_events`** — everything except `raw_payload`. That column is the
  platform's untouched body and carries customer PII by definition.
- **`cost_history`** — enough to see *whether* costs are arriving and by what
  route. `unit_cost_minor` and `sku` are excluded: a merchant's per-unit costs
  are the most commercially sensitive thing they hand us, and coverage is
  already answered by `order_profit`.
- **`platform_credentials`** — nothing. Stated as an explicit `REVOKE` even
  though the blanket revoke above it already covers the table, because this is
  the one exclusion that is a requirement rather than a consequence.

There is deliberately **no `ALTER DEFAULT PRIVILEGES`**. A table a future
migration creates is invisible to the portal until somebody grants it on
purpose, so a table added later holding something sensitive is not readable by
accident. The cost is a deploy step: re-run the script when a migration adds a
column the portal needs.

`last_error` is granted, because it is the most useful column in
`webhook_events` at 03:00 — on a condition that belongs to the integration
service and is worth writing down: **a handler must never embed payload content
in an error message.**

## The startup probe

Grants are the guarantee. A guarantee nobody checks is a guarantee that gets
quietly removed, so the portal asks Postgres three questions before it will read
a database at all:

```sql
current_setting('default_transaction_read_only') = 'on'
has_table_privilege(current_user, 'orders', 'INSERT')
has_table_privilege(current_user, 'platform_credentials', 'SELECT')
(select array_agg(distinct platform) from stores)
```

The third catches an explicit prohibition — the portal must not be able to read
merchant credentials, not even masked. The fourth catches the mistake no
privilege can: a correctly read-only connection pointed at the **wrong
platform's** database, where every number comes back plausible and filed under
the wrong name.

Problems are reported as a **list, not a winner**. A database can be both
writable and the wrong one, and a union that picked the more severe would hide
the second until the first was fixed — two deploys to learn what one probe
already knew.

**Any problem blocks that platform**, and it appears in `failed` beside the
platforms that are merely down. Blocking is the right severity for all three:
a writable connection means the safety boundary is not in place, a readable
credentials table means the portal can see what it must not, and a mismatched
platform means every figure is correct and mislabelled.

Successful probes are cached for the life of the process — configuration does
not change under a running container. **Failures are not cached**, or a network
blip during the first request would wedge a platform as broken until someone
redeployed.

## Fan-out

`Promise.allSettled`, never `Promise.all`. One platform's database being
unreachable degrades that platform's section and nothing else.

The other half matters as much: a gap must be **visible**. Every response
carries `partial` and the platforms that are missing, because a number that
silently omits a platform is worse than no number — it looks authoritative, it
is wrong, and nobody rechecks a figure that rendered fine.

Connections are deliberately scarce: pool max 3, `statement_timeout` 5s,
`idle_in_transaction_session_timeout` 15s, `CONNECTION LIMIT 5` on the role, and
`application_name` set to `ghalla-ops:<platform>` so an operator staring at
`pg_stat_activity` on a busy integration database can see which connections are
the portal's. The portal is one person; the integration service is serving every
merchant, and they draw from the same server.

## Derived metrics — the signatures

Defined once, here, and never inlined anywhere else. Ambiguity in these is what
produces two screens showing different numbers for the same thing.

```ts
// lib/queries/mrr.ts
//
// Stores with status `active` or `past_due`. Trialing excluded — a trial is not
// revenue. Prices come from PLANS via `annualisedPrice`, which multiplies a
// MONTHLY plan by twelve rather than using the discounted annual figure. The
// plan is the EFFECTIVE one, via `effectivePlanCode`, so an agreed downgrade
// counts at the tier still being paid for until that period ends.
export interface MrrBreakdown {
  readonly listMrrMinor: Minor;
  readonly byPlan: readonly { planCode: string; stores: number; listMrrMinor: Minor }[];
  readonly unknownPlans: readonly { planCode: string; stores: number }[];
}
export function mrr(handle: PlatformHandle, at: Instant): Promise<MrrBreakdown>;

// lib/queries/coverage.ts
//
// REVENUE-weighted, not SKU-count-weighted: the numerator and denominator are
// summed separately and divided once, which is the same arrangement
// `order_profit` uses and for the same reason. Read from `daily_store_rollup`,
// which already holds both terms; `dirtyBuckets` is returned beside them
// because a rollup awaiting rebuild is a number that will change.
export interface Coverage {
  readonly revenueExVatMinor: Minor;
  readonly coveredRevenueExVatMinor: Minor;
  readonly coverageBps: number | null;   // null when revenue is zero: a ratio to nothing
  readonly dirtyBuckets: number;
}
export function storeCoverage(handle: PlatformHandle, storeId: string, window: DateWindow): Promise<Coverage>;
export function platformCoverage(handle: PlatformHandle, window: DateWindow): Promise<Coverage>;

// lib/queries/orders-in-period.ts
//
// `ingestion_source = 'live'` between `current_period_start` and
// `current_period_end`. Never a calendar month, never including backfill — and
// deliberately through `usageWindow` from @ghalla/billing, the same function the
// merchant's own usage banner counts with. Two implementations of "orders this
// period" is two screens disagreeing about whether someone is over their cap.
export function ordersInPeriod(handle: PlatformHandle, storeId: string): Promise<number>;

// lib/queries/health.ts
//
// Derived on read, never stored. A store that fixes itself stops being
// unhealthy without anything having to delete a row.
export type HealthFlag =
  | 'silent'          // zero webhook events in 24h while the subscription is active
  | 'jobs_failing'    // webhook_events in `failed` above the threshold
  | 'backfill_stuck'  // backfill started, not complete, older than 24h
  | 'coverage_low'    // coverage below 20%
  | 'past_due';
export interface StoreHealth {
  readonly storeId: string;
  readonly flags: readonly HealthFlag[];
  readonly healthy: boolean;   // flags.length === 0
}
export function storeHealth(handle: PlatformHandle, window: DateWindow): Promise<readonly StoreHealth[]>;

// lib/queries/activation.ts
//
// Backfill complete AND coverage above 50% AND at least one dashboard session.
// The third input does not exist yet, so it is `null` rather than `false`, and
// `activated` is `null` while any input is unknown: a store that cannot be
// assessed has not failed.
export interface Activation {
  readonly storeId: string;
  readonly backfillComplete: boolean;
  readonly coverageAbove50: boolean;
  readonly dashboardSession: boolean | null;
  readonly activated: boolean | null;
}
export function activation(handle: PlatformHandle): Promise<readonly Activation[]>;

// lib/queries/alerts.ts
//
// An alert is a QUERY over current state plus `alert_ack`, not a row. The key is
// stable — `silent_store:<platform>:<store id>` — so an acknowledgement survives
// recomputation. Acknowledgements expire 24h after `acknowledged_at`, computed
// at read time: a job that expires them is a job that can fail to run, and its
// failure mode is an alert that stays silenced.
export interface Alert {
  readonly key: string;
  readonly kind: AlertKind;
  readonly platform: PlatformId;
  readonly storeId: string | null;
  readonly detail: string;
  readonly acknowledgedUntil: Instant | null;
}
export function alerts(registry: PlatformRegistry, acks: AckLookup): Promise<FanOut<readonly Alert[]>>;
```

Everything cross-platform goes through one entry point:

```ts
queryPlatforms(registry, async (handle) => …): Promise<FanOut<T>>
```

which verifies first, skips what it must not read, runs the rest with
`allSettled`, and returns `partial` with the names of what is missing.

## What the query layer refuses to do twice

Every rule that also exists on the merchant's side is imported rather than
rewritten, because the failure mode of a second implementation is two screens
disagreeing about one number and nobody able to say which is right.

- **Which plan a store is on** — `effectivePlanCode` from `@ghalla/billing`, so
  an agreed downgrade counts at the tier still being paid for.
- **Which statuses are revenue** — derived from a new `isBilled` predicate,
  which sits beside `isPaying` precisely because they are one word apart and
  differ on trials. `SUBSCRIPTION_STATUSES.filter(isBilled)` builds the SQL
  list, so adding a status to the domain and forgetting it here is impossible.
- **Which orders count toward a cap** — `usageWindow`, the same function the
  merchant's usage banner counts with. The batch form expresses that window as
  a join because one query per store makes a list page take four seconds, and a
  test asserts the two agree store by store.

Two of those needed a small change upstream: `effectivePlanCode` and
`usageWindow` now take a `Pick` of `Subscription` rather than the whole row.
The portal reads through a role granted per COLUMN and does not hold most of
them, and widening the signature was cheaper than letting it write its own copy.

## Arithmetic that had to round in the right place

**MRR annualises before it sums.** A monthly plan contributes twelve times its
price, an annual plan contributes its own, and the division by twelve happens
ONCE at the end. Dividing per store rounds once per subscription, and a hundred
annual subscribers then accumulate an error nobody can account for. The same
argument one level up is why `MrrBreakdown` carries `listArrMinor`: a
cross-platform total sums ARR and divides once, rather than adding rounded MRRs.

**Coverage never stores a ratio.** Numerator and denominator travel separately
all the way to the point of display, per store, per platform, and across
platforms. Same for the webhook success rate. A stored percentage cannot be
re-weighted when it is combined, and the rollup that forgets to re-weight is
wrong in a way no test catches.

**A rate over nothing is `null`, not zero and not 100%.** A platform with no
traffic has not achieved a perfect success rate, and painting one green is how
a silent integration goes unnoticed for a week. A store with no revenue has not
got bad coverage, and sorting it as zero puts every quiet store at the top of
the worst-coverage list.

## Degrading instead of failing

Four places, one principle: an operator in the middle of an incident needs what
can still be shown, labelled.

| Failure | What happens |
|---|---|
| A platform database is down | Its section is missing, `partial` is true, and it is named. Every other platform renders. |
| A platform's grants are wrong | It is **not queried at all** and appears in the same list — a number from a connection that can also write is not one to publish. |
| The acknowledgement store is down | Alerts still render, marked `acksUnavailable`, all shown unacknowledged. |
| The portal's own database is down | `/api/live` returns 503 and the pages that do not need it still serve. |

The exception is configuration: a platform listed with no `DATABASE_URL_*`
fails at startup. It will never fix itself, and starting anyway would make a
deploy-time typo look exactly like an outage.

## What an adversarial review found

Seven dimensions reviewed in parallel, every finding then put to three
independent skeptics each instructed to refute it. Twenty-five findings raised,
seven survived. All seven are fixed, and each has a regression test.

**An open redirect on the login page, and it was the guard's own subject.**
`safeNext` rejected an off-site target by testing for a literal `//` prefix.
`new URL` is not a string comparison: WHATWG resolution treats a BACKSLASH as a
slash for special schemes and strips raw TAB, LF and CR before parsing at all.
So `/\host`, `/<TAB>/host`, `/<LF>/host` and `/<CR>/host` all passed and then
resolved to a foreign origin — carried by the same 303 that sets the session
cookie, moments after the operator typed the one shared key for every merchant's
data. The fix is structural rather than a blacklist: resolve the candidate
against a fixed unreachable base with the same parser that will later resolve
it, and require the origin to match. The guard and its consumer now cannot
disagree, whatever equivalence the URL specification grows next.

**A store's failure list was the platform's.** `recentFailures` took the twenty
newest failed events with no store predicate and filtered afterwards in
JavaScript. `failed` is a terminal dead-letter state that nothing clears, so on
any platform with more than a handful of stores the newest twenty belong to
whichever store is loudest — and an empty list reads as "this store has no
failures" on the one screen somebody opened because they think it is broken.
The predicate is in SQL now.

**Store detail could 500 instead of degrading.** It is the only read path that
does not go through `queryPlatforms`, so nothing caught a rejection for it; its
`verify` call was no protection because successful probes are cached for the
life of the process, so a platform that was up at startup keeps answering
"reachable" while its database refuses connections. The `unavailable` branch
that exists for exactly that outage was unreachable.

**The unmapped-rail queue counted payment legs and called them orders.**
`order_payments` is one row per leg, so an order settled in two captures counted
twice — ranking a rail by how often it is split rather than by how much of the
business uses it. Now `count(distinct orders.id)`, and test orders are excluded:
a test order is not evidence a rail deserves a fee rule.

**The overview's "stores" was the subscription-row count.** It disagreed with
the store list in both directions — a store between its install webhook and its
first billing webhook has no subscription row, and an uninstalled store still
has one — while both screens printed the word "stores". Exactly the failure this
document says the query layer exists to prevent. `StatusCounts.total` is now
`subscriptions`, named for what it holds, and the overview counts `stores`.

Two more were fixed against the panel's verdict, because it refuted them and I
think it was wrong:

- **No `error` listener on a `pg` Pool.** `pg` emits `error` on the pool when an
  idle client fails — a database restart, a proxy reaping a connection — and an
  `error` event with no listener is an uncaught exception in Node. The pool has
  already discarded the broken client by then, so the fix logs rather than
  exits; what is not acceptable is that a service cycling connections all night
  does it silently. This affects every service, so it landed in `createPool`.
- **A dynamic route segment decoded twice.** Next has already decoded it, and a
  second pass throws `URIError` on a store id containing a bare `%`.

Eighteen findings were refuted and are recorded as such: the confident-sounding
ones included a permanent lockout via the global rate limiter, a `Promise.all`
at the fan-out choke point, and cross-currency coverage summing. Each was
checked against the code and did not survive.

## Deliberately not built yet

- **No styling.** Design is a later brief, and anything invented now would read
  as a decision while waiting to be deleted. The pages exist to prove the data
  flows.
- **No admin action proxying.** There is nothing on the other end of it yet —
  `ghalla-salla` has no webhook controller, no recompute and no backfill.
- **No snapshots**, so `/api/revenue` returns `series: null` with the reason
  beside it rather than an empty chart. MRR over time is a question about the
  past and integration databases hold only the present.
- **Route handlers hold no logic** — parse, delegate to `lib/`, respond. That is
  the rule the coverage exclusions for `src/app/**` and `middleware.ts` depend
  on. A route that starts making decisions comes back into coverage with it.
