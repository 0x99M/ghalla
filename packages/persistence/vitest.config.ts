import { defineConfig } from 'vitest/config';

/**
 * This suite is slower than a unit suite, on purpose.
 *
 * Every file here boots PGlite — a real Postgres compiled to WebAssembly — and
 * applies the full migration set to it. That is the point: the CHECK
 * constraints, the partial indexes and `FOR UPDATE SKIP LOCKED` are the things
 * most likely to be wrong, and none of them exist against a mock.
 *
 * The cost is that vitest's defaults (5s per test, 10s per hook) are sized for
 * unit tests and not for booting a database. Under `--coverage` the
 * instrumentation pushed several of these past the line at once, and the
 * release gate started failing on timing rather than on correctness — which is
 * worse than a slow suite, because a gate that cries wolf gets ignored.
 *
 * So: generous timeouts, and a cap on how many WebAssembly Postgres instances
 * exist at the same moment. Serial would also work and is twice as slow; two at
 * a time is the point where the contention stopped.
 *
 * `groupOrder` is not decoration. Vitest refuses to run at all when two
 * projects disagree about `maxWorkers` inside one group, so this suite gets a
 * group of its own — which is the arrangement we wanted regardless: the pure
 * suites run flat out first, and the database suite follows without competing
 * with them for cores.
 */
export default defineConfig({
  test: {
    testTimeout: 60_000,
    hookTimeout: 60_000,
    maxWorkers: 2,
    minWorkers: 1,
    sequence: { groupOrder: 1 },
  },
});
