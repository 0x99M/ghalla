import type { PlatformId } from '@ghalla/contracts';
import { describeError } from '../errors';

/**
 * Running one query against every integration database at once.
 *
 * The rule this file exists to enforce: NEVER `Promise.all`. The portal reads
 * several independent databases, and `Promise.all` rejects the moment the first
 * of them does — so one platform having a bad afternoon would blank a page that
 * could have shown everything else perfectly well. Settling every task costs a
 * little more merging and turns a total outage into a labelled gap.
 *
 * Which is the other half: a gap must be VISIBLE. Every response carries
 * `partial` and the platforms that failed, because a number that silently
 * omits a platform is worse than no number — it looks authoritative and is
 * wrong, and nobody rechecks a figure that rendered fine.
 */

export interface PlatformResult<T> {
  readonly platform: PlatformId;
  readonly value: T;
}

export interface PlatformFailure {
  readonly platform: PlatformId;
  readonly reason: string;
}

export interface FanOut<T> {
  readonly ok: readonly PlatformResult<T>[];
  readonly failed: readonly PlatformFailure[];
  /** True when at least one platform is missing from `ok`. Surfaced in every response. */
  readonly partial: boolean;
  /** What the design calls "last updated". Returned in the payload rather than inferred by the client. */
  readonly capturedAt: string;
}

export interface FanOutTarget {
  readonly platform: PlatformId;
}

export interface FanOutOptions {
  /** Injected so a test can assert the timestamp instead of racing it. */
  readonly now?: (() => string) | undefined;
}

/**
 * Every target started at once, and each failure turned into a value where it
 * happens.
 *
 * This is the `allSettled` rule in its strongest form. `allSettled` pairs its
 * results back to its inputs BY ARRAY POSITION, which is a guarantee the type
 * system cannot express — the merge ends up indexing an array and testing for
 * an `undefined` that the specification says cannot occur. Catching inside each
 * task instead carries the platform along with its own outcome, so nothing is
 * ever paired by position and there is no impossible case to write a branch for.
 *
 * The `async` wrapper is not decoration either: it catches a task that throws
 * SYNCHRONOUSLY, which would otherwise escape during the `map` and take down
 * the whole fan-out — the exact failure this file exists to prevent, arriving
 * through the one door that looks safe.
 *
 * There is no join across databases here and there cannot be one; they are
 * separate Postgres servers. Anything that looks like a join is a merge over
 * these results, done in TypeScript, by a caller that knows what it is merging.
 */
export async function fanOut<TTarget extends FanOutTarget, TValue>(
  targets: readonly TTarget[],
  run: (target: TTarget) => Promise<TValue>,
  options: FanOutOptions = {},
): Promise<FanOut<TValue>> {
  const now = options.now ?? ((): string => new Date().toISOString());

  const running = targets.map((target) => ({
    target,
    outcome: (async (): Promise<
      { readonly ok: true; readonly value: TValue } | { readonly ok: false; readonly reason: string }
    > => {
      try {
        return { ok: true, value: await run(target) };
      } catch (error) {
        return { ok: false, reason: describeError(error) };
      }
    })(),
  }));

  const ok: PlatformResult<TValue>[] = [];
  const failed: PlatformFailure[] = [];

  // Sequential awaits over promises that are ALL ALREADY RUNNING. The
  // concurrency happened in the map above; this loop only collects, in input
  // order, which is what makes the output stable.
  for (const entry of running) {
    const outcome = await entry.outcome;
    if (outcome.ok) {
      ok.push({ platform: entry.target.platform, value: outcome.value });
    } else {
      failed.push({ platform: entry.target.platform, reason: outcome.reason });
    }
  }

  return { ok, failed, partial: failed.length > 0, capturedAt: now() };
}
