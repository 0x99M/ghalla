# 0009 — Ghalla Ops, the internal operator portal

**Status:** step 1 of the brief is built — the portal schema and its migration,
the `PlatformRegistry`, and the read-only role with its exact grants. The query
layer, the routes and the pages are next, and the derived-metric signatures at
the bottom of this file are what they will be built against.

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
reachable without it. That is what will be built.

It has one property worth stating plainly, because it shows up in this
schema: **there is no identity.** `admin_action_log.actor_session` and
`alert_ack.actor_session` are named for what they can actually hold — a session
fingerprint, not a person. With one shared key, "who ran the backfill" is not a
question the portal can answer, and columns called `actor` would have implied it
could. Rotation is a redeploy, and revocation is the same act.

For one operator that is a fair trade. It stops being one the day a second
person has the key, and the honest signal that the day has come is somebody
asking who did something.

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

### Prices have to live somewhere, and `plans.ts` refuses them

`packages/billing/src/plans.ts` says, in as many words, that prices are not
there: the platform charges the merchant and is the only place an amount is
authoritative, and a second copy would create two numbers that can disagree
about what somebody owes. MRR needs a price anyway.

The resolution is a separate `LIST_PRICES` map in the same package, named for
what it is. Nothing charges from it. What it produces is **list MRR** — what
these subscriptions would bill at list price — and that label has to survive
onto the screen, because it ignores discounts, coupons, proration, tax and
failed collection. An operator who reads it as revenue will be wrong by
whatever those add up to.

Two mechanisms keep it honest, covering two different failures:

- `Record<PlanCode, Minor>` is **total**, so adding a plan without pricing it
  does not compile;
- the MRR query still reports `unpricedPlans`, for a plan code read from a
  database that a newer deploy wrote and this build has never heard of. Without
  it, that subscription silently leaves the sum and MRR appears to fall.

**This is the one thing that is blocked on you: the list price for each of the
four monthly plans.** Annual is derived at ten months' worth, per
[0008](./0008-billing.md).

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
// revenue. Annual plans divided by twelve. The plan is the EFFECTIVE one, via
// `effectivePlanCode` from @ghalla/billing, so an agreed downgrade counts at
// the tier still being paid for until the period it was paid for ends.
export interface MrrBreakdown {
  readonly listMrrMinor: Minor;
  readonly byPlan: readonly { planCode: string; stores: number; listMrrMinor: Minor }[];
  readonly unpricedPlans: readonly { planCode: string; stores: number }[];
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

## Deliberately not built yet

- **No pages beyond a scaffold.** Design is a later brief, and anything invented
  now would read as a decision while waiting to be deleted.
- **No admin action proxying.** There is nothing on the other end of it yet.
- **Route handlers hold no logic** — parse, delegate to `lib/`, respond. That is
  the rule the coverage exclusion for `src/app/**` depends on. A route that
  starts making decisions comes back into coverage with it.
