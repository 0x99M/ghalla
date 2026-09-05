import { describe, expect, it } from 'vitest';
import { toInstant, toMinor } from '@ghalla/contracts';
import type { Instant, PlatformId } from '@ghalla/contracts';
import {
  ACK_TTL_MS,
  UNAVAILABLE_ALERTS,
  alertKey,
  applyAcks,
  platformUnreachableAlert,
  sortAlerts,
  storeAlerts,
} from '../src/lib/queries/alerts';
import type { StoreFacts } from '../src/lib/queries/store-health';

const DEMO = 'demo' as PlatformId;
const NOW = toInstant('2026-09-05T12:00:00.000Z');
const DAY = 24 * 3_600_000;
const ago = (ms: number): Instant => toInstant(new Date(Date.parse(NOW) - ms).toISOString());

const facts = (overrides: Partial<StoreFacts> = {}): StoreFacts => ({
  storeId: 'demo:1',
  installedAt: ago(60 * DAY),
  uninstalledAt: null,
  subscription: {
    storeId: 'demo:1',
    planCode: 'growth',
    effectivePlanCode: 'growth',
    status: 'active',
    currentPeriodStart: ago(10 * DAY),
    currentPeriodEnd: toInstant('2026-10-05T12:00:00.000Z'),
    trialEndsAt: null,
    lastReconciledAt: null,
    pendingPlanCode: null,
  },
  coverage: {
    revenueExVatMinor: toMinor(100_000),
    coveredRevenueExVatMinor: toMinor(90_000),
    coverageBps: 9_000,
    ordersCount: 10,
    dirtyBuckets: 0,
  },
  lastWebhookAt: ago(3_600_000),
  failedJobs: 0,
  backfill: { status: 'complete', itemsFetched: 10, startedAt: ago(50 * DAY), lastAdvancedAt: null },
  ordersInPeriod: 10,
  dashboardSession: null,
  ...overrides,
});

describe('alertKey', () => {
  it('is stable, which is what lets an acknowledgement survive recomputation', () => {
    expect(alertKey('silent_store', 'demo', 'demo:1')).toBe('silent_store:demo:demo:1');
    expect(alertKey('platform_unreachable', 'demo', null)).toBe('platform_unreachable:demo');
  });
});

describe('storeAlerts', () => {
  it('raises nothing for a healthy store', () => {
    expect(storeAlerts(DEMO, facts(), NOW)).toEqual([]);
  });

  it('raises a silent store, and says when it was last heard from', () => {
    const alerts = storeAlerts(DEMO, facts({ lastWebhookAt: ago(3 * DAY) }), NOW);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ kind: 'silent_store', storeId: 'demo:1' });
    expect(alerts[0]?.detail).toContain(ago(3 * DAY));
  });

  it('says so plainly when a store has never sent anything', () => {
    const alerts = storeAlerts(DEMO, facts({ lastWebhookAt: null }), NOW);
    expect(alerts[0]?.detail).toBe('no webhook has ever arrived from this store');
  });

  it('raises a single failed job, unlike the health flag which waits for a pattern', () => {
    // The health flag decides whether a store is worth ranking as unhealthy;
    // an alert is something to look at. One failure is worth looking at.
    const alerts = storeAlerts(DEMO, facts({ failedJobs: 1 }), NOW);
    expect(alerts.map((alert) => alert.kind)).toEqual(['failed_jobs']);
  });

  it('raises a stuck backfill and a past-due subscription', () => {
    const alerts = storeAlerts(
      DEMO,
      facts({
        backfill: { status: 'running', itemsFetched: 1, startedAt: ago(7 * DAY), lastAdvancedAt: null },
        subscription: { ...facts().subscription!, status: 'past_due' },
      }),
      NOW,
    );
    expect(alerts.map((alert) => alert.kind)).toEqual(['stuck_backfill', 'past_due']);
  });
});

describe('applyAcks', () => {
  const alert = storeAlerts(DEMO, facts({ lastWebhookAt: null }), NOW);

  it('marks an acknowledged alert rather than hiding it', () => {
    // An operator who acknowledged something at 03:00 has to be able to see, at
    // 09:00, what they said they had handled.
    const acked = applyAcks(alert, new Map([[alert[0]!.key, ago(3_600_000)]]), NOW);
    expect(acked[0]?.acknowledgedUntil).toBe(
      new Date(Date.parse(ago(3_600_000)) + ACK_TTL_MS).toISOString(),
    );
  });

  it('LETS A PERSISTING PROBLEM RESURFACE after the acknowledgement expires', () => {
    const acked = applyAcks(alert, new Map([[alert[0]!.key, ago(ACK_TTL_MS)]]), NOW);
    expect(acked[0]?.acknowledgedUntil).toBeNull();
  });

  it('ignores acknowledgements for alerts that are no longer raised', () => {
    expect(applyAcks([], new Map([['silent_store:demo:gone', NOW]]), NOW)).toEqual([]);
  });

  it('leaves an unacknowledged alert alone', () => {
    expect(applyAcks(alert, new Map(), NOW)[0]?.acknowledgedUntil).toBeNull();
  });
});

describe('sortAlerts', () => {
  it('puts unacknowledged first, because the list is read top-down at 03:00', () => {
    const raised = [
      { ...alertOf('a'), acknowledgedUntil: NOW },
      { ...alertOf('b'), acknowledgedUntil: null },
    ];
    expect(sortAlerts(raised).map((alert) => alert.key)).toEqual([
      'platform_unreachable:b',
      'platform_unreachable:a',
    ]);
  });
});

function alertOf(platform: string) {
  return platformUnreachableAlert(platform as PlatformId, 'down');
}

describe('platformUnreachableAlert', () => {
  it('is not tied to a store', () => {
    expect(platformUnreachableAlert(DEMO, 'connection refused')).toMatchObject({
      kind: 'platform_unreachable',
      storeId: null,
      detail: 'connection refused',
    });
  });
});

describe('UNAVAILABLE_ALERTS', () => {
  it('names the alert types that cannot be computed yet, and why', () => {
    // An alert type that silently produces nothing is indistinguishable from
    // one that found nothing wrong, and those are opposite situations.
    expect(Object.keys(UNAVAILABLE_ALERTS).sort()).toEqual([
      'coverage_drop',
      'reconciliation_spike',
      'signature_failures',
    ]);
  });
});
