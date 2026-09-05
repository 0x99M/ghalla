# @ghalla/ops — the internal operator portal

Reads every integration database. Writes to none of them.

Each integration (`ghalla-salla`, `ghalla-zid`, …) is a separate Railway service
with its **own Postgres**. This app connects to all of them at once through a
read-only role, merges the results in application code, and keeps its own small
database for the things the integration databases structurally cannot hold —
history, and operator state.

Design and the decisions behind it: [`docs/0009-ops-portal.md`](../../docs/0009-ops-portal.md).

## The safety boundary

**The portal connects as `ghalla_ops_ro`, a role that cannot write.** Not the
application role used carefully — a role the database itself will not let write.

Every write the portal offers (recompute, backfill, replay a webhook, force a
reconciliation) goes through the integration's own authenticated admin API. The
integration service owns its invariants: queue jobs, dirty-bucket marking, audit
trails. A direct write from here would bypass all of them and corrupt state in a
way that is very hard to trace back.

Four layers hold this up, and only the last one is a guarantee:

| | Layer | Catches |
|---|---|---|
| 1 | `ReadOnlyDatabase` exposes `select` and nothing else | `db.insert(orders)` does not compile |
| 2 | `no-restricted-imports` on `@ghalla/persistence` | the write repositories cannot be imported |
| 3 | dependency-cruiser | and cannot be reached transitively or dynamically |
| 4 | **the `ghalla_ops_ro` role** | and if the first three fail, the server refuses |

The application also **probes for layer 4 at startup** and refuses to read a
database that comes back writable, that lets it see `platform_credentials`, or
that turns out to hold another platform's stores. A database the grants were
never applied to fails loudly instead of quietly working.

## Setting up the read-only role

Run [`sql/ghalla_ops_ro.sql`](./sql/ghalla_ops_ro.sql) against **every**
integration database, as that database's owner:

```bash
psql "$DATABASE_URL" \
  -v ON_ERROR_STOP=1 \
  -v ops_password="$(openssl rand -base64 24)" \
  -f apps/ghalla-ops/sql/ghalla_ops_ro.sql
```

The script is idempotent and it asserts its own outcome — it raises rather than
committing if the role can write to `orders`, read `platform_credentials`, read
`webhook_events.raw_payload`, or read `orders.customer_ref`.

It grants **columns, not tables**. The portal has no reason to read a customer
reference, a delivery address, a raw webhook payload or a merchant's per-SKU
costs, and "no reason to" is not a boundary until the server agrees. The
consequence is a deploy step: **re-run the script after a migration adds a column
the portal needs.** There is deliberately no `ALTER DEFAULT PRIVILEGES`, so a
table added later is invisible until somebody decides it may be seen.

## Environment

```bash
# The portal's own database. Never DATABASE_URL: this service holds a connection
# string for every integration at once, and the generic name is the one most
# likely to be pasted with the wrong value.
PORTAL_DATABASE_URL=postgres://…/ghalla_ops

# Adding a platform is these three lines and nothing else. No code change.
GHALLA_PLATFORMS=salla,zid
DATABASE_URL_SALLA=postgres://ghalla_ops_ro:…@…/ghalla_salla
ADMIN_API_URL_SALLA=https://…            # optional until the admin API exists
ADMIN_API_TOKEN_SALLA=…                  # server-side only, never in a bundle
```

A platform listed with no `DATABASE_URL_*` **fails at startup**. That is a
deploy-time typo which will never fix itself, and starting anyway would make it
look exactly like an outage. A platform that is configured and *down* is the
opposite case and is handled the opposite way: the portal serves, and every
response says which platform is missing.

## Commands

```bash
pnpm --filter @ghalla/ops dev              # local
pnpm --filter @ghalla/ops build
pnpm --filter @ghalla/ops test
pnpm --filter @ghalla/ops db:generate      # after editing the portal schema
pnpm --filter @ghalla/ops migrate:deploy   # applies portal migrations only
```

`migrate:deploy` is plain JavaScript on purpose — the Drizzle migrator reads the
generated SQL and its journal, never the schema module, so it needs no build
step and no drizzle-kit in the runtime image. It is pointed at
`PORTAL_DATABASE_URL` and cannot touch an integration database.
