import { describeError } from './errors';
import { describeCheck } from './platforms/registry';
import type { ConnectionCheck, PlatformRegistry } from './platforms/registry';

/**
 * Two different questions, answered by one endpoint and deliberately kept apart.
 *
 * IS THE PORTAL ALIVE — which is what Railway's health check asks, and the only
 * thing that may fail a deploy. An integration database being down must NOT
 * fail it: the brief requires the portal to start and serve with a platform
 * unreachable, and a health check that restarts the container because someone
 * else's database is down turns their outage into ours.
 *
 * WHAT CAN IT SEE — which is for the operator. That is `status: 'degraded'` and
 * a list, in a 200 response, because it is information and not a fault.
 */

export type HealthStatus = 'ok' | 'degraded' | 'error';

export interface PlatformHealth {
  readonly platform: string;
  readonly reachable: boolean;
  readonly usable: boolean;
  readonly detail: string | null;
}

export interface HealthReport {
  readonly status: HealthStatus;
  readonly portalDatabase: 'ok' | 'error';
  readonly portalDatabaseError: string | null;
  readonly platforms: readonly PlatformHealth[];
  readonly partial: boolean;
  readonly checkedAt: string;
}

export interface HealthDeps {
  readonly registry: PlatformRegistry;
  readonly pingPortal: () => Promise<void>;
  readonly now?: (() => string) | undefined;
}

export function toPlatformHealth(check: ConnectionCheck): PlatformHealth {
  const usable = check.reachable && check.problems.length === 0;
  return {
    platform: check.platform,
    reachable: check.reachable,
    usable,
    detail: usable ? null : describeCheck(check),
  };
}

export async function checkHealth(deps: HealthDeps): Promise<HealthReport> {
  const now = deps.now ?? ((): string => new Date().toISOString());

  let portalError: string | null = null;
  try {
    await deps.pingPortal();
  } catch (error) {
    portalError = describeError(error);
  }

  // Never `Promise.all`, here least of all: this is the endpoint whose job is
  // to survive a platform being down.
  let checks: readonly ConnectionCheck[] = [];
  try {
    checks = await deps.registry.verifyAll();
  } catch (error) {
    // `verifyAll` catches per-platform failures itself, so reaching this means
    // something structural broke. Reported rather than thrown, because a health
    // endpoint that 500s tells the operator nothing at all.
    portalError ??= describeError(error);
  }

  const platforms = checks.map(toPlatformHealth);
  const partial = platforms.some((platform) => !platform.usable);

  return {
    status: portalError !== null ? 'error' : partial ? 'degraded' : 'ok',
    portalDatabase: portalError === null ? 'ok' : 'error',
    portalDatabaseError: portalError,
    platforms,
    partial,
    checkedAt: now(),
  };
}
