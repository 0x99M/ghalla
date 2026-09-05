import { describe, expect, it } from 'vitest';
import { toInstant } from '@ghalla/contracts';
import {
  DEGRADED_SUCCESS_BPS,
  STORE_VIEWS,
  activationFunnel,
  alertPresentation,
  applyStoreView,
  capUsage,
  filterByIdentifier,
  healthLabel,
  isStoreView,
  mergePlanRevenue,
  platformState,
  recentChurns,
  recentInstalls,
  savedViewCounts,
  severityOf,
  storePresentation,
  tenureMonths,
  webhookFunnel,
} from '../src/lib/ui/presentation';
import type { IngestionHealth } from '../src/lib/queries/ingestion';
import type { Alert } from '../src/lib/queries/alerts';
import { storeFixtures } from '../src/lib/fixtures/stores';
import { revenueFixture } from '../src/lib/fixtures/reports';

const byId = (id: string) => {
  const store = storeFixtures.find((candidate) => candidate.platformStoreId === id);
  if (store === undefined) throw new Error(`no fixture ${id}`);
  return store;
};

describe('severityOf', () => {
  it('separates losing data from having incomplete data', () => {
    // The split is the whole point: "act now" must not look like "fix this
    // week", or the table reads as noise by Thursday.
    expect(severityOf(['silent'])).toBe('bad');
    expect(severityOf(['past_due'])).toBe('bad');
    expect(severityOf(['jobs_failing'])).toBe('bad');
    expect(severityOf(['backfill_stuck'])).toBe('warn');
    expect(severityOf(['coverage_low'])).toBe('warn');
    expect(severityOf([])).toBe('ok');
  });

  it('takes the worst flag when several apply', () => {
    expect(severityOf(['coverage_low', 'past_due'])).toBe('bad');
  });
});

describe('healthLabel', () => {
  it('names every flag, not only the worst', () => {
    // A store that is both silent and past due is a different conversation
    // from one that is only silent.
    expect(healthLabel(['silent', 'past_due'])).toBe('Silent · past due');
    expect(healthLabel(['backfill_stuck'])).toBe('Backfill stuck');
    expect(healthLabel([])).toBe('Healthy');
  });
});

describe('capUsage', () => {
  it('reports an overage truthfully', () => {
    const store = byId('1740092255');
    expect(capUsage(store).overCap).toBe(true);
    expect(capUsage(store).percent).toBeGreaterThan(100);
  });

  it('has no percentage against an unlimited plan', () => {
    const scale = { ...byId('1305146709') };
    const store = {
      ...scale,
      subscription: scale.subscription === null ? null : { ...scale.subscription, effectivePlanCode: 'scale' },
    };
    expect(capUsage(store)).toStrictEqual({ used: store.ordersInPeriod, cap: null, percent: null, overCap: false });
  });

  it('answers a plan code this build does not know with null, never zero', () => {
    // A rollback to an image that predates a plan must not render every store
    // on it as being at 0% of nothing.
    const base = byId('1305146709');
    const store = {
      ...base,
      subscription: base.subscription === null ? null : { ...base.subscription, effectivePlanCode: 'enterprise_v9' },
    };
    expect(capUsage(store).percent).toBeNull();
    expect(capUsage(store).overCap).toBe(false);
  });
});

describe('storePresentation', () => {
  it('makes over-cap alone a warning and over-cap with bad data critical', () => {
    expect(storePresentation(byId('1220884471')).severity).toBe('warn');
    expect(storePresentation(byId('1740092255')).severity).toBe('bad');
  });

  it('calls zero coverage what it is', () => {
    // "Low coverage" on a store with no costs at all understates it: there is
    // nothing to be low, and every margin on that store is fallback.
    expect(storePresentation(byId('1902773641')).label).toBe('No coverage');
  });

  it('reads a departed store as churned and not as an incident', () => {
    const churned = storePresentation(byId('55771902'));
    expect(churned.label).toBe('Churned');
    // `ok` deliberately: painting it red would put it outside the
    // needs-attention filter, which filters on `health.healthy`.
    expect(churned.severity).toBe('ok');
  });
});

describe('savedViewCounts', () => {
  it('counts each view over the whole list', () => {
    const counts = savedViewCounts(storeFixtures);
    expect(counts.trialing).toBe(storeFixtures.filter((s) => s.subscription?.status === 'trialing').length);
    expect(counts.pastDue).toBe(storeFixtures.filter((s) => s.subscription?.status === 'past_due').length);
    expect(counts.silent).toBe(storeFixtures.filter((s) => s.health.flags.includes('silent')).length);
    expect(counts.overCap).toBeGreaterThan(0);
  });
});

describe('activationFunnel', () => {
  it('reports Activated as unknown rather than zero', () => {
    // Nothing records whether a merchant has opened their dashboard. A zero
    // would draw a wall at the end of the funnel and send somebody hunting a
    // product problem that does not exist.
    const steps = activationFunnel(storeFixtures);
    const activated = steps.find((step) => step.step === 'Activated');
    expect(activated?.count).toBeNull();
    expect(activated?.share).toBeNull();
  });

  it('starts at the installed count and shares against it', () => {
    const steps = activationFunnel(storeFixtures);
    expect(steps[0]?.count).toBe(storeFixtures.length);
    expect(steps[0]?.share).toBe(100);
    expect(steps[0]?.drop).toBeNull();
  });

  it('survives an empty list without dividing by zero', () => {
    for (const step of activationFunnel([])) {
      expect(step.share).toBeNull();
      expect(step.drop).toBeNull();
    }
  });
});

describe('recent movements', () => {
  it('excludes a store that already left from recent installs', () => {
    const installs = recentInstalls(storeFixtures, 20);
    expect(installs.every((store) => store.uninstalledAt === null)).toBe(true);
  });

  it('lists only departures, newest first', () => {
    const churns = recentChurns(storeFixtures, 20);
    expect(churns.length).toBeGreaterThan(0);
    expect(churns.every((store) => store.uninstalledAt !== null)).toBe(true);
  });

  it('floors tenure to whole months', () => {
    expect(tenureMonths('2026-01-15T00:00:00.000Z', '2026-04-14T00:00:00.000Z')).toBe(2);
    expect(tenureMonths('2026-01-15T00:00:00.000Z', '2026-04-15T00:00:00.000Z')).toBe(3);
    expect(tenureMonths('2026-04-15T00:00:00.000Z', '2026-04-16T00:00:00.000Z')).toBe(0);
  });
});

describe('webhookFunnel', () => {
  const health = (over: Partial<IngestionHealth>): IngestionHealth => ({
    processed: 0,
    failed: 0,
    skipped: 0,
    pending: 0,
    processing: 0,
    stalled: 0,
    oldestPendingAt: null,
    ...over,
  });

  it('keeps skipped out of both success and failure', () => {
    // An event this adapter does not handle was seen and dismissed. Folding it
    // into "processed" would make a platform sending mostly events we ignore
    // look perfectly healthy.
    const bands = webhookFunnel(health({ processed: 80, failed: 10, skipped: 10 }));
    expect(bands.map((band) => [band.label, band.count, band.share])).toStrictEqual([
      ['Resolved', 100, 100],
      ['Processed', 80, 80],
      ['Skipped', 10, 10],
      ['Failed', 10, 10],
    ]);
  });

  it('has no share when nothing resolved', () => {
    for (const band of webhookFunnel(health({ pending: 40 }))) expect(band.share).toBeNull();
  });
});

describe('platformState', () => {
  const health = (over: Partial<IngestionHealth>): IngestionHealth => ({
    processed: 0,
    failed: 0,
    skipped: 0,
    pending: 0,
    processing: 0,
    stalled: 0,
    oldestPendingAt: null,
    ...over,
  });

  it('never calls a silent platform live', () => {
    // `successRateBps` returns null rather than 100% for exactly this reason:
    // painting a silent integration green is how it goes unnoticed for a week.
    expect(platformState(health({}), null)).toStrictEqual({ tone: 'neutral', label: 'Quiet' });
  });

  it('ranks a stalled worker above a poor rate', () => {
    expect(platformState(health({ stalled: 3 }), 9_990).label).toBe('Attention');
  });

  it('reads below the threshold as degraded', () => {
    expect(platformState(health({}), DEGRADED_SUCCESS_BPS - 1).label).toBe('Degraded');
    expect(platformState(health({}), DEGRADED_SUCCESS_BPS).label).toBe('Live');
  });
});

describe('alertPresentation', () => {
  const alert = (over: Partial<Alert>): Alert => ({
    key: 'silent_store:salla:salla:1',
    kind: 'silent_store',
    platform: 'salla' as Alert['platform'],
    storeId: 'salla:1',
    detail: 'no webhook has ever arrived from this store',
    acknowledgedUntil: null,
    ...over,
  });

  it('gives billing its own badge', () => {
    expect(alertPresentation(alert({ kind: 'past_due' })).badge).toBe('BILLING');
    expect(alertPresentation(alert({ kind: 'silent_store' })).badge).toBe('CRITICAL');
    expect(alertPresentation(alert({ kind: 'stuck_backfill' })).badge).toBe('HIGH');
  });

  it('drops the urgency of an acknowledged alert but keeps its badge', () => {
    const acked = alertPresentation(alert({ acknowledgedUntil: toInstant('2026-09-06T00:00:00.000Z') }));
    expect(acked.severity).toBe('ok');
    expect(acked.badge).toBe('CRITICAL');
  });
});

describe('store views and filtering', () => {
  it('recognises only the declared views', () => {
    for (const view of STORE_VIEWS) expect(isStoreView(view)).toBe(true);
    expect(isStoreView('everything')).toBe(false);
  });

  it('narrows to each view', () => {
    expect(applyStoreView(storeFixtures, null)).toBe(storeFixtures);
    expect(applyStoreView(storeFixtures, 'silent').every((s) => s.health.flags.includes('silent'))).toBe(true);
    expect(applyStoreView(storeFixtures, 'over_cap').every((s) => capUsage(s).overCap)).toBe(true);
    expect(applyStoreView(storeFixtures, 'trialing').every((s) => s.subscription?.status === 'trialing')).toBe(true);
    expect(applyStoreView(storeFixtures, 'past_due').every((s) => s.subscription?.status === 'past_due')).toBe(true);
    expect(
      applyStoreView(storeFixtures, 'low_coverage').every((s) => s.health.flags.includes('coverage_low')),
    ).toBe(true);
  });

  it('matches identifiers case-insensitively and returns everything on a blank query', () => {
    expect(filterByIdentifier(storeFixtures, '   ')).toBe(storeFixtures);
    expect(filterByIdentifier(storeFixtures, 'ZID').every((s) => s.platform === 'zid')).toBe(true);
    expect(filterByIdentifier(storeFixtures, '1305146709')).toHaveLength(1);
    expect(filterByIdentifier(storeFixtures, 'no-such-store')).toHaveLength(0);
  });
});

describe('mergePlanRevenue', () => {
  it('sums a plan across platforms and sorts by MRR', () => {
    const merged = mergePlanRevenue(revenueFixture('30d'));
    expect(merged.length).toBeGreaterThan(0);
    const amounts = merged.map((plan) => plan.listMrrMinor);
    expect([...amounts].sort((a, b) => b - a)).toStrictEqual(amounts);

    const growth = merged.find((plan) => plan.planCode === 'growth');
    const perPlatform = revenueFixture('30d')
      .byPlatform.flatMap((entry) => entry.mrr.byPlan)
      .filter((plan) => plan.planCode === 'growth');
    expect(growth?.stores).toBe(perPlatform.reduce((sum, plan) => sum + plan.stores, 0));
  });
});

describe('coverage of the paths fixtures do not reach', () => {
  const base = byId('1305146709');

  it('has no cap percentage for a store with no subscription row', () => {
    // Between the install webhook and the first billing webhook a store has no
    // subscription at all. That is not a plan with a cap of zero.
    const store = { ...base, subscription: null };
    expect(capUsage(store)).toStrictEqual({
      used: store.ordersInPeriod,
      cap: null,
      percent: null,
      overCap: false,
    });
    expect(storePresentation(store).cap.percent).toBeNull();
  });

  it('counts Activated once anything actually measures it', () => {
    // The moment an integration records a dashboard session, `activated` stops
    // being null and the step becomes a number. Pinned here so the funnel is
    // known to work in both worlds, not only today's.
    const measured = storeFixtures.map((store, index) => ({
      ...store,
      activation: { ...store.activation, dashboardSession: true, activated: index % 2 === 0 },
    }));
    const step = activationFunnel(measured).find((entry) => entry.step === 'Activated');
    expect(step?.count).toBe(measured.filter((store) => store.activation.activated === true).length);
    expect(step?.share).not.toBeNull();
  });

  it('orders several departures newest first', () => {
    const churns = recentChurns(storeFixtures, 20);
    expect(churns.length).toBeGreaterThan(1);
    const dates = churns.map((store) => store.uninstalledAt);
    expect([...dates].sort((a, b) => b.localeCompare(a))).toStrictEqual(dates);
  });
});
