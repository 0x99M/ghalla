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
      'packages/persistence',
      'apps/ghalla-salla',
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
        'packages/ports/src/**',
        'packages/schemas/src/{assert,drift}.ts',
        'packages/persistence/src/db/schema.ts',
        // Entry points and process wiring, covered by the staging smoke test
        // rather than by unit tests that would only assert their own mocks.
        'packages/persistence/src/db/{pool,migrate}.ts',
        'apps/*/src/main.ts',
        // Framework wiring: a test would assert that NestJS dependency
        // injection works, which is NestJS's job. The logic inside the factory
        // — loadEnv — is covered directly.
        'apps/*/src/**/*.module.ts',
        // Standalone CLI entry points, run by db:clear / db:seed against a real
        // database. Their logic is covered; their process wiring is not.
        'packages/persistence/src/db/clear.ts',
        'packages/persistence/src/db/seeds/**',
      ],
      thresholds: {
        lines: 95,
        functions: 95,
        branches: 95,
        statements: 95,
      },
    },
  },
});
