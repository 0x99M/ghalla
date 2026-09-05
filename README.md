# غلة — Ghalla

**اعرف ربحك الحقيقي** — *know your real profit.*

Profit analytics for e-commerce merchants. Merchants see revenue; Ghalla computes true
**contribution margin** per order and per SKU, after COGS, actual carrier shipping cost, COD
handling, payment gateway fees, and returns/RTO.

---

## Architecture principle

> All profit logic is platform-agnostic and lives in a shared core package.
> Platform SDKs, payload shapes, and vocabulary never leak into it.

Each platform integration deploys as its own service with its own database. They share
**code**, not infrastructure. The core is a library, not a service.

This is enforced mechanically, at four layers, and it is [verified by planting deliberate
violations](./docs/0001-domain-model.md#what-was-verified-not-assumed) rather than assumed:

| Layer | Mechanism | Catches |
|---|---|---|
| **L1** | the package.json graph + pnpm isolated linking | an undeclared third-party import — unresolvable at typecheck, test *and* runtime. No `eslint-disable` reaches it |
| **L2** | `rootDir` + `"lib": ["ES2024"], "types": []` | a relative escape into a package that is not a declared project reference; `fetch`, `process` and `Buffer` do not typecheck in the pure layer |
| **L3** | ESLint `no-restricted-imports` + `no-restricted-syntax` | forbidden SDKs and type-only imports, the relative-path route into a *referenced* package, and purity leaks no import rule can see — `new Date`, `Math.random`, `parseFloat`, `globalThis`, aliasing, dynamic `import()` |
| **L4** | dependency-cruiser | transitive reach, undeclared dependencies, and the raw payload reaching anything but the adapter boundary |

There was a fifth. `eslint-plugin-boundaries` sat where L3 is now, and it was removed because an
adversarial review established that it reported nothing at all under its shipped configuration
while this table credited it — and arming it correctly needed a module resolver plus three
coordinated option changes to catch only what the other layers already caught. A credited but
silent enforcement layer is worse than an absent one.

Plus a ten-second grep, because the rule *"platform vocabulary appears nowhere under
`packages/`"* is about identifiers and strings, not modules — which is why `PlatformId` is an
opaque brand rather than a union of platform names. It matches case-insensitively on
substrings, not word boundaries: `\b` would miss `sallaOrderId` and `SALLA_ORDER_ID`, which is
every shape a real violation actually takes.

## Layout

```
packages/
  contracts/     canonical domain types — zero runtime dependencies, enforced in CI
  schemas/       zod validation for those types, kept out of the engine's dependency graph
  core/          the profit engine — PURE: no I/O, no clock, no randomness
  ports/         interfaces every platform adapter must implement
  persistence/   Drizzle schema, migrations and repositories — one schema, one database per platform
apps/            one service per platform (none yet)
tooling/
  tsconfig/      shared compiler presets: base, library, app
  eslint-config/ the boundary rules
```

## Status

**Phase 1, step 1 complete — the domain model and the profit engine.**

`computeOrderProfit` is implemented, pure and total: no I/O, no clock, no randomness, and it
never throws — for any input, including `null`. The Drizzle schema and its migration are in, and
the schema tests run against a real Postgres in-process via PGlite — no Docker, no service
container. 23 golden fixtures, 222 tests, `pnpm verify` green.

- **[docs/0001-domain-model.md](./docs/0001-domain-model.md)** — the seven decisions that
  shape the canonical types, every deviation from the original brief with its justification.
- **[docs/0002-profit-engine.md](./docs/0002-profit-engine.md)** — the six product questions
  now decided, what implementing the arithmetic changed about the model, and how the fixtures
  are checked independently of the implementation that produced them.

- **[docs/0003-engine-review.md](./docs/0003-engine-review.md)** — what an adversarial review of
  the arithmetic found, and what changed as a result.
- **[docs/0004-persistence.md](./docs/0004-persistence.md)** — the schema, why money is
  `numeric(14, 2)` and still exact, and how the database enforces the domain.

Next: the remaining repositories, then `ingestion` against a fake adapter, then the first real
platform.

## Working on it

```bash
pnpm install
pnpm verify        # architecture guards → typecheck → lint → test → dependency graph
```

Individually: `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm arch`. Database work:
`pnpm db:generate` after a schema change, `pnpm db:migrate` to apply locally, `pnpm db:studio` to
browse. The schema tests need no database of their own — they run Postgres in-process. The same command runs on
every push and pull request — see [`.github/workflows/ci.yml`](./.github/workflows/ci.yml).

The guards run *first*, deliberately: one of them asserts that exactly one `eslint.config.*`
exists in the worktree. ESLint 10 resolves config by walking up from each linted file, so a
config dropped inside a package detaches every boundary rule — and `pnpm lint` then exits 0
with no output while the violations sit on disk.

Requires Node ≥ 22.13 and pnpm 11.25.0 (via corepack). TypeScript is pinned to the **6.x**
line on purpose: npm's `latest` is the 7.0 native port, which ships no programmatic compiler
API — `typescript-eslint` peers `<6.1.0`, so TS 7 would silently disarm the boundary lint.

## Non-negotiables

- No floats for money. Integer minor units, as a branded type — a bare `number` is not
  assignable to a money field.
- No platform vocabulary in `core` or `contracts`.
- No live cost joins in profit queries — costs are snapshotted at ingestion, so correcting a
  cost today cannot silently change last quarter's profit.
- No inline webhook processing.
- No customer PII in the database — structurally, via a compile-time key deny-list over all
  fourteen canonical types, and a CHECK constraint that rejects a referrer carrying a path.
- No `Number()` on a money column. Integer halalas in the domain, `numeric(14, 2)` in Postgres,
  one digit-wise codec between them.
