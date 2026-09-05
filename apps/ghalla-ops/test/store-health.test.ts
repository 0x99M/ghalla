import { describe, expect, it } from 'vitest';
import { toInstant, toMinor } from '@ghalla/contracts';
import type { Instant } from '@ghalla/contracts';
import {
  ACTIVATION_COVERAGE_BPS,
  COVERAGE_LOW_BPS,
  FAILED_JOBS_THRESHOLD,
  activation,
  healthFlags,
  isBackfillStuck,
  isCoverageLow,
  isLive,
  isSilent,
  storeHealth,
} from '../src/lib/queries/store-health';
import type { StoreFacts } from '../src/lib/queries/store-health';
import type { SubscriptionRow } from '../src/lib/queries/subscriptions';

const NOW = toInstant('2026-09-05T12:00:00.000Z');
const DAY = 24 * 3_600_000;
const ago = (ms: number): Instant => toInstant(new Date(Date.parse(NOW) - ms).toISOString());

const subscription = (status: SubscriptionRow['status']): SubscriptionRow => ({
  storeId: 'demo:1',
  planCode: 'growth',
  effectivePlanCode: 'growth',
  status,
  currentPeriodStart: ago(10 * DAY),
  currentPeriodEnd: toInstant('2026-10-05T12:00:00.000Z'),
  trialEndsAt: null,
  lastReconciledAt: null,
  pendingPlanCode: null,
});

const facts = (overrides: Partial<StoreFacts> = {}): StoreFacts => ({
  storeId: 'demo:1',
  installedAt: ago(60 * DAY),
  uninstalledAt: null,
  subscription: subscription('active'),
  coverage: {
    revenueExVatMinor: toMinor(100_000),
    coveredRevenueExVatMinor: toMinor(90_000),
    coverageBps: 9_000,
    ordersCount: 10,
    dirtyBuckets: 0,
  },
  lastWebhookAt: ago(3_600_000),
  failedJobs: 0,
  backfill: { status: 'complete', itemsFetched: 100, startedAt: ago(50 * DAY), lastAdvancedAt: ago(50 * DAY) },
  ordersInPeriod: 40,
  dashboardSession: null,
  ...overrides,
});

describe('isLive', () => {
  it('is false for a store that uninstalled', () => {
    // Without this, every store that ever left keeps alerting as silent for as
    // long as its rows are retained, and the list fills with ex-customers.
    expect(isLive(facts({ uninstalledAt: ago(DAY) }))).toBe(false);
  });

  it('is false for a cancelled subscription and for none at all', () => {
    expect(isLive(facts({ subscription: subscription('canceled') }))).toBe(false);
    expect(isLive(facts({ subscription: null }))).toBe(false);
  });

  it('is true while the merchant still has access, trial included', () => {
    expect(isLive(facts({ subscription: subscription('trialing') }))).toBe(true);
    expect(isLive(facts({ subscription: subscription('past_due') }))).toBe(true);
  });
});

describe('isSilent', () => {
  it('fires when nothing has been heard for a day', () => {
    expect(isSilent(facts({ lastWebhookAt: ago(2 * DAY) }), NOW)).toBe(true);
  });

  it('does NOT fire for a store installed an hour ago with no traffic yet', () => {
    // Otherwise every new install alerts on its first morning — which is
    // exactly when somebody is watching it, and exactly how an alert list
    // teaches people to ignore it.
    expect(isSilent(facts({ installedAt: ago(2 * 3_600_000), lastWebhookAt: null }), NOW)).toBe(false);
  });

  it('fires for an old store that has NEVER sent anything', () => {
    expect(isSilent(facts({ lastWebhookAt: null }), NOW)).toBe(true);
  });

  it('does not fire for a store that has left', () => {
    expect(isSilent(facts({ uninstalledAt: ago(DAY), lastWebhookAt: null }), NOW)).toBe(false);
  });

  it('catches a TRIALING store, which is the most important version of the signal', () => {
    const trialing = facts({ subscription: subscription('trialing'), lastWebhookAt: ago(2 * DAY) });
    expect(isSilent(trialing, NOW)).toBe(true);
  });

  it('treats exactly 24 hours as silent', () => {
    expect(isSilent(facts({ lastWebhookAt: ago(DAY) }), NOW)).toBe(true);
    expect(isSilent(facts({ lastWebhookAt: ago(DAY - 1) }), NOW)).toBe(false);
  });
});

describe('isBackfillStuck', () => {
  it('fires for a backfill that started a week ago and has not finished', () => {
    expect(isBackfillStuck(facts({ backfill: { status: 'running', itemsFetched: 1, startedAt: ago(7 * DAY), lastAdvancedAt: null } }), NOW)).toBe(true);
  });

  it('includes failed and paused, which look the same from the operator side', () => {
    for (const status of ['failed', 'paused']) {
      expect(isBackfillStuck(facts({ backfill: { status, itemsFetched: 1, startedAt: ago(2 * DAY), lastAdvancedAt: null } }), NOW)).toBe(true);
    }
  });

  it('does not fire for a backfill that has finished, or one that just started', () => {
    expect(isBackfillStuck(facts(), NOW)).toBe(false);
    expect(isBackfillStuck(facts({ backfill: { status: 'running', itemsFetched: 1, startedAt: ago(3_600_000), lastAdvancedAt: null } }), NOW)).toBe(false);
  });

  it('does not fire when no backfill was ever started', () => {
    expect(isBackfillStuck(facts({ backfill: null }), NOW)).toBe(false);
  });
});

describe('isCoverageLow', () => {
  it('fires below the threshold', () => {
    expect(isCoverageLow(facts({ coverage: { ...facts().coverage!, coverageBps: COVERAGE_LOW_BPS - 1 } }))).toBe(true);
    expect(isCoverageLow(facts({ coverage: { ...facts().coverage!, coverageBps: COVERAGE_LOW_BPS } }))).toBe(false);
  });

  it('does NOT fire when there is no revenue to have coverage of', () => {
    // No data is not bad coverage. Flagging it would put every quiet store on
    // the unhealthy list and bury the ones that are genuinely mispriced.
    expect(isCoverageLow(facts({ coverage: { ...facts().coverage!, coverageBps: null } }))).toBe(false);
    expect(isCoverageLow(facts({ coverage: null }))).toBe(false);
  });
});

describe('healthFlags', () => {
  it('is empty for a healthy store', () => {
    expect(storeHealth(facts(), NOW)).toEqual({ storeId: 'demo:1', flags: [], healthy: true });
  });

  it('reports every problem a store has, not the first', () => {
    const broken = facts({
      lastWebhookAt: ago(3 * DAY),
      failedJobs: FAILED_JOBS_THRESHOLD,
      backfill: { status: 'running', itemsFetched: 1, startedAt: ago(7 * DAY), lastAdvancedAt: null },
      coverage: { ...facts().coverage!, coverageBps: 100 },
      subscription: subscription('past_due'),
    });
    expect(healthFlags(broken, NOW)).toEqual([
      'silent',
      'jobs_failing',
      'backfill_stuck',
      'coverage_low',
      'past_due',
    ]);
    expect(storeHealth(broken, NOW).healthy).toBe(false);
  });

  it('needs the threshold to be reached, not merely approached', () => {
    expect(healthFlags(facts({ failedJobs: FAILED_JOBS_THRESHOLD - 1 }), NOW)).toEqual([]);
  });
});

describe('activation', () => {
  it('is UNKNOWN, not false, while the dashboard-session signal does not exist', () => {
    // A store that cannot be assessed has not failed to activate. Reporting it
    // as `false` would make the funnel's last step look like a wall when it is
    // really a missing measurement.
    const result = activation(facts());
    expect(result.backfillComplete).toBe(true);
    expect(result.coverageAboveThreshold).toBe(true);
    expect(result.dashboardSession).toBeNull();
    expect(result.activated).toBeNull();
  });

  it('is true only when all three inputs are', () => {
    expect(activation(facts({ dashboardSession: true })).activated).toBe(true);
    expect(activation(facts({ dashboardSession: false })).activated).toBe(false);
    expect(
      activation(facts({ dashboardSession: true, backfill: { status: 'running', itemsFetched: 0, startedAt: null, lastAdvancedAt: null } })).activated,
    ).toBe(false);
  });

  it('needs coverage strictly above the threshold', () => {
    const atThreshold = facts({
      dashboardSession: true,
      coverage: { ...facts().coverage!, coverageBps: ACTIVATION_COVERAGE_BPS },
    });
    expect(activation(atThreshold).coverageAboveThreshold).toBe(false);
  });

  it('treats unknown coverage as not activated', () => {
    expect(activation(facts({ dashboardSession: true, coverage: null })).coverageAboveThreshold).toBe(false);
  });
});
