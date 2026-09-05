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

This is enforced mechanically, at four layers, and it is [verified by planting a deliberate
violation](./docs/0001-domain-model.md#what-was-verified-not-assumed) rather than assumed:

| Layer | Mechanism | Catches |
|---|---|---|
| **L1** | the package.json graph + pnpm isolated linking | an undeclared import — unresolvable at typecheck, test *and* runtime. No `eslint-disable` reaches it |
| **L2** | `rootDir` + `"lib": ["ES2024"], "types": []` | a relative escape into another package; `fetch`, `process` and `Buffer` do not typecheck in the pure layer |
| **L4** | ESLint `boundaries` + `no-restricted-imports` + `no-restricted-syntax` | type-only imports, forbidden SDKs, and purity leaks no import rule can see — `new Date`, `Math.random`, `parseFloat` |
| **L5** | dependency-cruiser | dynamic `import()`, transitive reach, undeclared dependencies |

Plus a ten-second grep, because the rule *"platform vocabulary appears nowhere under
`packages/`"* is about identifiers and strings, not modules — which is why `PlatformId` is an
opaque brand rather than a union of platform names.

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

**Phase 1, step 1 — the domain model, awaiting sign-off.**

The type surface is complete. The profit arithmetic is deliberately **not** implemented:
every function body in `packages/core` throws `NotImplementedError`, because the point of
step 1 is to agree on the model before it calcifies.

Read **[docs/0001-domain-model.md](./docs/0001-domain-model.md)** — the seven decisions that
matter, every deviation from the original brief with its justification, and six open product
questions.

## Working on it

```bash
pnpm install
pnpm verify        # typecheck → lint → test → architecture checks
```

Individually: `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm arch`.

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
- No customer PII in the database — structurally, via a compile-time key deny-list.
