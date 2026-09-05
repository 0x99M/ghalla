# غلة — Ghalla

**اعرف ربحك الحقيقي** — *know your real profit.*

Profit analytics for e-commerce merchants. Merchants see revenue; Ghalla computes true
**contribution margin** per order and per SKU after COGS, actual carrier shipping cost,
COD handling, payment gateway fees, and returns/RTO.

First integration: **Salla**. Zid follows. The architecture exists to make the second
integration cheap.

---

## Architecture principle

> All profit logic is platform-agnostic and lives in a shared core package.
> Platform SDKs, payload shapes, and vocabulary never leak into it.

Each platform integration deploys as its own service with its own database.
They share **code**, not infrastructure. The core is a library, not a service.

This is enforced mechanically, not by convention — the build fails if `packages/core`
imports from `apps/*` or from any platform SDK.

## Layout

```
packages/
  contracts/     canonical domain types + schemas, zero runtime deps
  core/          profit engine, cost resolution, rollups — PURE, no I/O
  ports/         interfaces every platform adapter must implement
  persistence/   Prisma schema, migrations, repositories
  ingestion/     queue orchestration, idempotency, retry — platform-agnostic
apps/
  ghalla-salla/  Salla adapter + webhooks + dashboard API
  ghalla-zid/    scaffold — proves the abstraction holds
tooling/
  eslint-config/
  tsconfig/
```

## Status

Phase 1, step 1 — domain model. See [`docs/`](./docs) for the design record.

## Non-negotiables

- No floats for money. Integer minor units (halalas) everywhere.
- No platform vocabulary in `core` or `contracts`.
- No live cost joins in profit queries — costs are snapshotted at ingestion.
- No inline webhook processing.
- No customer PII in the database (PDPL).
