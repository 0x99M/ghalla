import { describe, expect, it, vi } from 'vitest';
import { toMinor } from '@ghalla/contracts';
import { PLANS, PURCHASABLE_PLAN_CODES } from '@ghalla/billing';
import type { PlatformPlan } from '@ghalla/ports';
import { CATALOG_TIMEOUT_MS, PlanCatalogService } from '../src/billing/plan-catalog.service.js';
import { isPlanCatalogAcceptable } from '../src/health/health.service.js';
import type { PlanCatalogSource } from '../src/billing/plan-catalog.source.js';

/**
 * The check that lets prices live in code.
 *
 * What matters here is not just that a mismatch is detected but WHAT IT DOES:
 * it fails the healthcheck, which stops the deploy that introduced it, and it
 * does NOT stop a running service. A price edited at 23:00 must not take down
 * every merchant's ingestion.
 */

const AT = '2026-09-05T12:00:00.000Z';

class TestService extends PlanCatalogService {
  protected override nowIso(): string {
    return AT;
  }
}

const correctCatalog = (): PlatformPlan[] =>
  PURCHASABLE_PLAN_CODES.map((code) => ({
    platformPlanId: `plat_${code}`,
    planCode: code,
    priceMinor: toMinor(PLANS[code].priceMinor),
    currency: 'SAR' as const,
    interval: PLANS[code].interval,
  }));

const sourceReturning = (plans: PlatformPlan[]): PlanCatalogSource => ({
  fetchPlans: async () => plans,
});

describe('PlanCatalogService', () => {
  it('starts as pending, which health treats as not yet ready', () => {
    // Green here would let a deploy pass its healthcheck on the first poll and
    // never learn the answer, which would give the gate no teeth at all.
    const service = new TestService(sourceReturning(correctCatalog()));
    expect(service.current()).toEqual({ state: 'pending' });
    expect(isPlanCatalogAcceptable(service.current())).toBe(false);
  });

  it('agrees with a correctly configured platform', async () => {
    const service = new TestService(sourceReturning(correctCatalog()));
    expect(await service.check()).toEqual({
      state: 'ok',
      plansChecked: PURCHASABLE_PLAN_CODES.length,
      checkedAt: AT,
    });
    expect(isPlanCatalogAcceptable(service.current())).toBe(true);
  });

  it('FAILS THE HEALTHCHECK when a price has been edited at the platform', async () => {
    const plans = correctCatalog();
    plans[0] = { ...plans[0]!, priceMinor: toMinor(19_900) };

    const service = new TestService(sourceReturning(plans));
    const status = await service.check();

    expect(status.state).toBe('mismatch');
    expect(isPlanCatalogAcceptable(status)).toBe(false);
    if (status.state !== 'mismatch') return;
    expect(status.problems[0]).toContain('12900');
    expect(status.problems[0]).toContain('19900');
  });

  it('names EVERY disagreement in the log line, because fixing them one at a time is an afternoon', async () => {
    const plans = correctCatalog().filter((p) => p.planCode !== 'scale');
    plans[0] = { ...plans[0]!, priceMinor: toMinor(1) };

    const status = await new TestService(sourceReturning(plans)).check();
    expect(status.state).toBe('mismatch');
    if (status.state !== 'mismatch') return;
    expect(status.problems.length).toBeGreaterThan(1);
  });

  it('reports UNVERIFIED, not ok, when nothing is wired', async () => {
    // A component that silently does nothing is indistinguishable from one that
    // found nothing wrong, and here that difference is a green light on the one
    // check standing between a partner-portal edit and a mischarged merchant.
    const service = new TestService(null);
    const status = await service.check();
    expect(status).toEqual({
      state: 'unverified',
      reason: expect.stringContaining('no plan catalog source'),
      checkedAt: null,
    });
    // Green, though: nothing being wired is not evidence of a fault on our side.
    expect(isPlanCatalogAcceptable(status)).toBe(true);
  });

  it('does not fail a deploy because the PLATFORM is down', async () => {
    // A third party's outage must not block every release we make.
    const service = new TestService({
      fetchPlans: async () => {
        throw new Error('connect ECONNREFUSED');
      },
    });
    const status = await service.check();
    expect(status).toMatchObject({ state: 'unverified', reason: 'connect ECONNREFUSED' });
    expect(isPlanCatalogAcceptable(status)).toBe(true);
  });

  it('gives up on a platform that accepts the call and never answers', async () => {
    vi.useFakeTimers();
    try {
      const service = new TestService({ fetchPlans: async () => new Promise(() => undefined) });
      const pending = service.check();
      await vi.advanceTimersByTimeAsync(CATALOG_TIMEOUT_MS + 1);
      const status = await pending;
      expect(status).toMatchObject({ state: 'unverified' });
      expect(status.state === 'unverified' && status.reason).toContain('did not answer');
    } finally {
      vi.useRealTimers();
    }
  });

  it('collapses concurrent checks into one call to the platform', async () => {
    const fetchPlans = vi.fn(async () => correctCatalog());
    const service = new TestService({ fetchPlans });
    await Promise.all([service.check(), service.check(), service.check()]);
    expect(fetchPlans).toHaveBeenCalledTimes(1);
  });

  it('re-checks after a previous check finished', async () => {
    const fetchPlans = vi.fn(async () => correctCatalog());
    const service = new TestService({ fetchPlans });
    await service.check();
    await service.recheck();
    expect(fetchPlans).toHaveBeenCalledTimes(2);
  });

  it('starts the check at boot without blocking it', async () => {
    // Blocking startup on a third party's API is what this codebase refuses to
    // do everywhere else; a consistency check is no reason for an exception.
    const service = new TestService(sourceReturning(correctCatalog()));
    service.onModuleInit();
    expect(service.current().state).toBe('pending');
    await service.check();
    expect(service.current().state).toBe('ok');
  });

  it('describes a thrown non-Error without losing it', async () => {
    const service = new TestService({
      fetchPlans: async () => {
        throw 'the socket hung up';
      },
    });
    expect(await service.check()).toMatchObject({ state: 'unverified', reason: 'the socket hung up' });
  });

  it('stamps a real timestamp outside the tests', async () => {
    const service = new PlanCatalogService(sourceReturning(correctCatalog()));
    const status = await service.check();
    expect(status.state).toBe('ok');
    expect(status.state === 'ok' && Number.isNaN(Date.parse(status.checkedAt))).toBe(false);
  });

  it('catches the unreleased tier being put on sale', async () => {
    const plans = [
      ...correctCatalog(),
      {
        platformPlanId: 'plat_ads',
        planCode: 'ads',
        priceMinor: toMinor(PLANS.ads.priceMinor),
        currency: 'SAR' as const,
        interval: 'month' as const,
      },
    ];
    const status = await new TestService(sourceReturning(plans)).check();
    expect(status.state).toBe('mismatch');
    if (status.state !== 'mismatch') return;
    expect(status.problems[0]).toContain('not for sale yet');
  });
});
