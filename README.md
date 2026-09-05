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

This is enforced mechanically, at three layers, and it is [verified by planting deliberate
violations](./docs/0001-domain-model.md#what-was-verified-not-assumed) rather than assumed:

| Layer | Mechanism | Catches |
|---|---|---|
| **L1** | the package.json graph + pnpm isolated linking | an undeclared third-party import — unresolvable at typecheck, test *and* runtime. No `eslint-disable` reaches it |
| **L2** | `rootDir` + `"lib": ["ES2024"], "types": []` | a relative escape into a package that is not a declared project reference; `fetch`, `process` and `Buffer` do not typecheck in the pure layer |
| **L3** | ESLint `no-restricted-imports` + `no-restricted-syntax` | forbidden SDKs and type-only imports, the relative-path route into a *referenced* package, and purity leaks no import rule can see — `new Date`, `Math.random`, `parseFloat`, `globalThis`, aliasing, dynamic `import()` |
| **L4** | dependency-cruiser | transitive reach, undeclared dependencies, and the raw payload reaching anything but the adapter boundary |

There were four. `eslint-plugin-boundaries` was the fourth and it was removed, because an
adversarial review established that it reported nothing at all under its shipped configuration
while the README credited it — and arming it correctly needed a module resolver plus three
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
apps/            one service per platform (none yet)
tooling/
  tsconfig/      shared compiler presets: base, library, app
  eslint-config/ the boundary rules
```

## Status

**Phase 1, step 1 complete — the domain model and the profit engine.**

`computeOrderProfit` is implemented and pure: no I/O, no clock, no randomness. 11 golden
fixtures, 103 tests, `pnpm verify` green.

- **[docs/0001-domain-model.md](./docs/0001-domain-model.md)** — the seven decisions that
  shape the canonical types, every deviation from the original brief with its justification.
- **[docs/0002-profit-engine.md](./docs/0002-profit-engine.md)** — the six product questions
  now decided, what implementing the arithmetic changed about the model, and how the fixtures
  are checked independently of the implementation that produced them.

Next: `persistence`, then `ingestion` against a fake adapter, then the first real platform.

## Working on it

```bash
pnpm install
pnpm verify        # architecture guards → typecheck → lint → test → dependency graph
```

Individually: `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm arch`. The same command runs on
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
  fourteen canonical types.
