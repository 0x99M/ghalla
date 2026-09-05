# 0005 — Testing and the release pipeline

**Status:** in place. The gate blocks a release below 95% coverage or on any failing test.
**Date:** 2026-09-05
**Follows:** [0004 — persistence](./0004-persistence.md)

---

## What each layer of the suite is for

Four layers, and each exists because the one below it cannot catch what it catches. A test that
duplicates the layer below is a test that will be deleted the first time it becomes inconvenient.

**Unit tests — is the arithmetic right?**
`packages/*/test/*.test.ts`. Pure functions with explicit inputs. This is where the money kernel
lives: `mulBps` checked against exact BigInt arithmetic, `splitVatInclusive` over thousands of
consecutive amounts, `allocateMinor` across generated shapes. No I/O, no database, no clock. They
run in under a second and they are the reason a rounding change cannot land quietly.

**Golden fixtures — does the whole engine agree with itself?**
`packages/core/test/fixtures/golden/`. Twenty-three orders as plain JSON, each with a recorded
expectation. The expectations are *generated* and then hand-checked, so the runner also asserts,
independently of what was recorded, what must be true of **any** implementation: both money
identities, the exact `Σ(lines) === totals` ties, `restockedCogs <= cogs`, safe-integer and
no-negative-zero on every field, determinism, and invariance to input ordering. A regenerated
expectation can only ever agree with the code; those assertions cannot.

**Schema tests — does the database enforce what the comments claim?**
`packages/persistence/test/`. The real migration applied to a real Postgres, in-process via PGlite.
Every CHECK constraint is exercised by trying to violate it. This layer earned its place on day one
by catching a `UNIQUE` that did not prevent duplicates because SQL treats every NULL as distinct.

**Staging smoke — does the deployed thing work?**
`scripts/verify-staging.sh`. Actual HTTP requests against the deployed service. It asserts the
health endpoint returns **200 and not merely a body saying "ok"** — the platform routes on the
status code — that the database is reachable from inside the container, that the commit being
served is the commit that was released, and that the pre-deploy migration actually ran.

Nothing above unit level is allowed to substitute for a unit test, and no unit test is allowed to
mock a database that PGlite could have run for real.

## The coverage gate

`vitest.config.ts` sets **95%** on statements, branches, functions and lines, measured across the
whole repository as one number. Per-package thresholds were rejected: they let a thinly-tested
package hide behind a well-tested one.

```
pnpm test           # fast: every suite, no instrumentation
pnpm test:coverage  # the gate. Exits non-zero below 95% on any metric.
```

CI runs the gate as its own step, so a failure says *coverage* rather than *tests*. It cannot be
satisfied by lowering a threshold or by adding a file to the exclusion list — both show up plainly
in a diff, which is the point.

Four kinds of file are excluded, and the reason is the same each time: **there is nothing to
execute, so including them reports 0% for something no test could ever cover.**

- Type-only modules — the canonical interfaces, the port definitions, the engine's result types.
- The Drizzle schema, which is a table declaration, exercised by the schema tests through SQL.
- Process entry points — `main.ts`, `migrate.ts`, `pool.ts` — covered by the staging smoke test
  instead, because a unit test of a process bootstrap asserts its own mocks.
- NestJS module files, which would test that dependency injection works. The logic inside the
  factories (`loadEnv`) is tested directly.

## The release pipeline

The order matters, and the steps are separated so a failure names itself.

```
pnpm release:check       # 1. gate    — arch guards, typecheck, lint, tests, coverage, dep graph
pnpm db:reset:staging    # 2. data    — clear, migrate, seed  (staging only; refuses production)
pnpm release:staging     # 3. release — push to main; staging auto-deploys; wait; verify
                         # 4. verify  — runs as the last step of the above, and standalone below
pnpm verify:staging      #    …or re-run the smoke test against staging at any time
```

**1. The gate.** Everything that must pass before a release is attempted. It runs locally and in CI
on every push and pull request, so by the time anyone decides to release, this has already passed —
the release just refuses to proceed if it has not.

**2. The data step is deliberately not part of a release.** `db:reset` destroys data, and a
pipeline that destroys data on every release is a pipeline that will one day destroy the wrong
data. It is its own command, run when a clean fixture state is wanted.

Two independent guards protect it: it refuses outright when the environment is named `production`,
and it refuses without `GHALLA_ALLOW_DESTRUCTIVE=1`. One guard catches the ordinary accident — a
shell that still has production credentials exported from an hour ago. The other catches a script
that runs it without anybody deciding to.

**3. Release to staging.** Staging auto-deploys from `main`, which is what makes a push the release
action. The script refuses to push a dirty working tree, then polls Railway until the deployment
reports `SUCCESS` — never treating "the upload returned" as "the deploy worked".

**4. Verify staging.** Then, and only then, the smoke test. A deployment that reports success and a
service that works are different claims; Railway reports the first.

**5. Promote to production.** Production is a separate environment with **no auto-deploy** — the
promotion is a deliberate act, and it happens only after staging has been verified on the same
commit. The production services are not created yet; when they are, the promotion runs the same
migration first and the same smoke test after, against the production URL.

## The seed

`packages/persistence/src/db/seeds/demo-store.ts`, and every id and amount in it is fixed. That is
what lets the smoke test assert an exact contribution margin rather than "a number appeared" — a
seed with a random component can only ever check that something happened.

Three orders, chosen because they are the shapes that actually break:

| Order | Shape | What it pins |
|---|---|---|
| `demo:1:1001` | Prepaid card, delivered | The ordinary path. Margin SAR 212.10 |
| `demo:1:1002` | Refused cash-on-delivery | Two shipping legs, no revenue, goods back on the shelf. Margin −SAR 44.00, not −SAR 164.00 |
| `demo:1:1003` | No cost recorded | `confidence.level: incomplete` — the gate that keeps a guessed margin out of loss-maker ranking |

If a release regresses any of the three, the margin moves and the smoke test says which.

## Running it locally

```bash
pnpm install
pnpm build
pnpm dev:api            # http://localhost:3000/api/v1/health
```

The API needs a `DATABASE_URL`. For a throwaway one, point it at the staging database — or run
Postgres locally and `pnpm db:reset` against it. The unit and schema suites need **no** database:
PGlite runs Postgres in-process, which is also why CI needs no service container.

## Runbook

| Situation | Command |
|---|---|
| Before opening a pull request | `pnpm verify` |
| Before releasing | `pnpm release:check` |
| Staging data has drifted | `GHALLA_ALLOW_DESTRUCTIVE=1 pnpm db:reset` |
| Release to staging | `pnpm release:staging` |
| Is staging healthy right now | `pnpm verify:staging` |
| A deploy failed | `railway logs --service ghalla-salla-api --lines 200` |
| The engine's arithmetic changed | Bump `CALC_VERSION`; the guard fails the build otherwise |
