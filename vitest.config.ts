import { defineConfig } from 'vitest/config';

/**
 * One coverage number for the whole repository.
 *
 * Each package can still run its own suite (`pnpm --filter … test`), but the
 * release gate needs a single figure, and per-package thresholds would let a
 * thinly-tested package hide behind a well-tested one.
 */
export default defineConfig({
  test: {
    projects: [
      'packages/contracts',
      'packages/core',
      'packages/schemas',
      'packages/billing',
      'packages/persistence',
      'apps/ghalla-salla',
      'apps/ghalla-ops',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'html', 'json-summary', 'lcov'],
      reportsDirectory: './coverage',
      include: ['packages/*/src/**/*.ts', 'apps/*/src/**/*.ts'],
      exclude: [
        '**/index.ts',
        '**/*.d.ts',
        // Type-only modules: nothing to execute, so including them reports 0%
        // for files that cannot be covered by definition.
        'packages/contracts/src/{store,order,order-item,shipment,product,reversal,payment,pii,pii-audit,brand}.ts',
        'packages/core/src/{config,cost,input,result,fee-rules,confidence}.ts',
        'packages/billing/src/index.ts',
        'packages/ports/src/**',
        'packages/schemas/src/{assert,drift}.ts',
        'packages/persistence/src/db/schema.ts',
        'apps/ghalla-ops/src/lib/db/portal-schema.ts',
        // Entry points and process wiring, covered by the staging smoke test
        // rather than by unit tests that would only assert their own mocks.
        'packages/persistence/src/db/{pool,migrate}.ts',
        'apps/*/src/main.ts',
        // Next.js route handlers and pages. A route handler is a signature the
        // framework calls, and the rule this exclusion depends on is that they
        // hold NO logic: parse, delegate to lib/, respond. Everything worth
        // testing lives under lib/ and is tested there. A route that starts
        // making decisions has to come back into coverage with it.
        'apps/ghalla-ops/src/app/**',
        // Pool construction and a driver handle. The behaviour worth testing —
        // what a connection probe MEANS — is `evaluateProbe`, which is pure.
        'apps/ghalla-ops/src/lib/db/portal-db.ts',
        'apps/ghalla-ops/src/lib/platforms/postgres-connection.ts',
        // Framework wiring: a test would assert that NestJS dependency
        // injection works, which is NestJS's job. The logic inside the factory
        // — loadEnv — is covered directly.
        'apps/*/src/**/*.module.ts',
        // Standalone CLI entry points, run by db:clear / db:seed against a real
        // database. Their logic is covered; their process wiring is not.
        'packages/persistence/src/db/clear.ts',
        'packages/persistence/src/db/seeds/**',
      ],
      /**
       * 99% on all four, and the build fails below it.
       *
       * What is left uncovered is nine branches in nine different files, each
       * the same shape: a `?? default` on a lookup that cannot miss, a second
       * check of something already validated, or a range guard the type system
       * already enforces. Getting past them would mean deleting safety nets in
       * money code to move a number, which is the wrong trade — so they stay,
       * and the number stops here.
       *
       * Reaching this did find real things, which is the argument for the gate:
       * a NestJS provider that resolved in tests and failed in the container, a
       * regex duplicated between two files where only one copy was ever
       * checked, and a suite that timed out under instrumentation and would
       * have blocked releases at random.
       */
      thresholds: {
        lines: 99,
        functions: 99,
        branches: 99,
        statements: 99,
      },
    },
  },
});
