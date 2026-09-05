import { defineConfig } from 'vitest/config';

/**
 * Shares the persistence suite's group, because these tests boot PGlite too —
 * the portal's own migrations are applied to a real Postgres, so the CHECK
 * constraints that carry this schema's invariants are actually exercised.
 *
 * See packages/persistence/vitest.config.ts for why the group exists at all.
 */
export default defineConfig({
  test: {
    testTimeout: 60_000,
    hookTimeout: 60_000,
    maxWorkers: 2,
    sequence: { groupOrder: 1 },
  },
});
