# 0006 — The ingestion queue is a table, not Redis

**Status:** accepted
**Supersedes:** the "BullMQ orchestration" line in [0002](./0002-profit-engine.md)

The brief forbids inline webhook processing, which means a queue. The reflexive answer in a NestJS
codebase is BullMQ, and BullMQ means Redis. This records why we are not doing that, what we built
instead, and the specific condition under which this decision should be reopened.

## The row exists either way

`webhook_events` is not a job record we could choose to keep elsewhere. Two of its properties are
load-bearing and neither can move to Redis:

- `unique (store_id, platform_event_id)` is **the** process-once guarantee. Platforms redeliver
  aggressively; duplicate delivery is normal operation, not an incident. That index is the only
  thing that actually decides which delivery wins — a check-then-insert loses the race.
- `raw_payload` is what makes an event replayable when an adapter turns out to have parsed it
  wrong. That has already happened once in this codebase's short life, in the engine rather than
  an adapter, and the fix required recomputing from source data.

So the choice was never "table or Redis". It was "table" or "table **and** Redis" — the same work
recorded in two stores that can disagree. When Redis says processed and the table says pending
while someone is reconciling a merchant's numbers, neither one is authoritative, and the merchant
is the one who finds out.

## The decisive reason is the transaction

Writing an `order_profit` row marks its rollup buckets dirty **in the same transaction**. That
atomicity is deliberate and it is documented in [0004](./0004-persistence.md): a result stored
without its buckets marked is a rollup that is silently stale, and because the sweep only looks at
dirty rows, nothing would ever notice.

A queue in another process cannot join that transaction. Enqueue-then-commit gives you a job for a
row that may roll back; commit-then-enqueue gives you a committed row whose follow-up job was lost
if the process died in between. This is the ordinary dual-write problem, and the ordinary fixes for
it — an outbox table, or a transactional log tail — both amount to *putting the queue back in
Postgres*, with Redis added on the far side for no remaining benefit.

`FOR UPDATE SKIP LOCKED` keeps the enqueue, the claim, and the business write in one place where a
transaction still means something.

## Scale is not the constraint

A hundred merchants at a thousand orders a day is roughly one to two events per second, with peaks
perhaps an order of magnitude above that. A single Postgres serving a `SKIP LOCKED` claim off a
partial index handles several orders of magnitude more than that. Throughput is not what would push
us to Redis, and choosing infrastructure for a load profile we do not have is how a two-service
deployment becomes a five-service one before the first merchant is onboarded.

Durability points the other way as well. Railway Redis without persistence explicitly configured
loses the queue on restart — silently, and in the direction that costs a merchant an order that
never computes.

## What was built

Two columns on `webhook_events`, in migration `0001_webhook_queue`:

- `next_attempt_at` — when the row becomes claimable. A failed attempt pushes it into the future
  rather than leaving it at the head of the queue. Without this a single poisonous event is
  re-claimed as fast as the worker can fail it, starving every healthy event behind it.
- `locked_at` — set when a worker claims a row, cleared when it lets go. This is what makes a
  crashed worker recoverable: the row is held, not lost, and the reaper tells held-and-alive from
  held-by-a-corpse by how old it is. Without it, every crash leaks one row per in-flight job,
  permanently.

Two partial indexes, `webhook_events_claimable_idx` and `webhook_events_inflight_idx`, because the
table is dominated by `processed` rows that neither hot query ever wants to see.

One constraint, `webhook_events_lock_iff_processing`: a row is held **if and only if** it is being
worked on. Both halves are silent failures — a `processing` row with no `locked_at` is invisible to
the reaper and stuck forever; a released row that kept its lock is a phantom the reaper keeps
"recovering". The database refuses both, and two tests prove it does.

`WebhookEventRepository` implements the state machine:

| Operation | What it guarantees |
|---|---|
| `enqueue` | `ON CONFLICT DO NOTHING`, so two simultaneous deliveries cannot both pass a check. Reports the id of the row that **won**, so a log line can name what this was a repeat of. |
| `claim` | `SELECT … FOR UPDATE SKIP LOCKED` then `UPDATE`, in one transaction. Oldest due first, so a store's events are not reordered. |
| `markProcessed` / `markSkipped` | Terminal, lock released. `skipped` is deliberately distinct from `processed` and from `failed`, so "we saw it and chose to ignore it" stays legible and does not sit in dead-letter triage. |
| `markFailed` | Exponential backoff to a dead letter after `maxAttempts`. Returns which of the two happened, because "will retry" and "a human must look" are different facts. |
| `reapStale` | Frees rows whose worker died. Rows that have already spent their attempts dead-letter here instead of looping — a job that reliably kills its worker is exactly the case a naive reaper retries forever. |
| `requeue` | Replays a dead letter with a clean attempt count. A dead-letter queue with no way out is a table of regrets. |
| `countByStatus` | Depth per status, including the zeroes: a missing key reads as "no data", not as "none stuck". |

The attempt counter increments at **claim**, not at failure. A worker that dies mid-job never
reaches its failure handler, so a counter that only rises on a clean failure lets a row that crashes
the worker retry forever.

Backoff is exponential, capped, and deliberately without jitter. Jitter exists to stop many workers
retrying in lockstep; claims here are batched by a small number of workers, so that herd does not
form, and a deterministic delay is one a test can assert exactly. If the worker count ever grows
enough to matter, derive the jitter from the row id — still deterministic, still testable, spread.

## What the tests do not cover

PGlite is a single backend, so these tests cannot run two workers claiming at the same instant.
They cover that the claim is valid SQL with `SKIP LOCKED` against the real planner, and every state
transition the workers depend on. Genuine concurrency is a property of `FOR UPDATE SKIP LOCKED`
itself; testing Postgres's locking is not our job.

## When to reopen this

One condition, and it is specific:

> We run the ingestion worker at **more than one replica** *and* we are hitting Salla's outbound API
> rate limits.

Rate-limiting outbound calls across replicas is the one thing Postgres does awkwardly and Redis does
well. At one worker process per platform service — which is the deployment today — an in-process
token bucket is correct, simpler, and has no second system to lose data.

Note what is **not** on that list: queue depth, throughput, retry scheduling, delayed jobs, or
cron. All of those are already served by a `timestamptz` column and an index.
