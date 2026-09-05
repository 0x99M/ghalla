import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NOW, createIntegrationDb, seed } from './support/integration-db';
import { createPortalDb } from './support/portal-db';
import { registryFor } from './support/registry';
import type { IntegrationDb } from './support/integration-db';
import type { PortalTestDb } from './support/portal-db';
import { overview } from '../src/lib/queries/overview';
import { revenue } from '../src/lib/queries/revenue';
import { storeList } from '../src/lib/queries/store-list';
import { storeDetail } from '../src/lib/queries/store-detail';
import { ingestionReport } from '../src/lib/queries/ingestion-report';
import { unknownPaymentMethodQueue } from '../src/lib/queries/payment-queue';
import { alertFeed } from '../src/lib/queries/alert-feed';
import { acknowledge, activeAcks, forget, recentAcks } from '../src/lib/portal/alert-acks';
import { acknowledgeAlert } from '../src/lib/portal/ack-action';
import { SESSION_HEADER } from '../src/lib/auth/session-header';

/**
 * The cross-platform layer, against a real database, with one platform
 * deliberately broken in most of these — because "a platform is down" is the
 * case the whole fan-out design exists for and it must not be the one nobody
 * exercised.
 */

let integration: IntegrationDb;
let portal: PortalTestDb;

beforeAll(async () => {
  [integration, portal] = await Promise.all([createIntegrationDb(), createPortalDb()]);
  await seed(integration.client);
}, 60_000);

afterAll(async () => {
  await Promise.all([integration.close(), portal.close()]);
});

const working = () => registryFor({ demo: integration.db });
const degraded = () => registryFor({ demo: integration.db }, { other: 'connection refused' });

describe('overview', () => {
  it('totals a single platform', async () => {
    const report = await overview(working(), NOW);
    expect(report.totals).toMatchObject({ stores: 6, active: 3, trialing: 1, pastDue: 1 });
    expect(report.partial).toBe(false);
    expect(report.platforms).toHaveLength(1);
  });

  it('SERVES with a platform down, and names the one that is missing', async () => {
    const report = await overview(degraded(), NOW);
    expect(report.partial).toBe(true);
    expect(report.missing).toEqual([{ platform: 'other', reason: 'connection refused' }]);
    // The platform that worked is still fully reported. `Promise.all` would
    // have blanked this entire page.
    expect(report.totals.stores).toBe(6);
  });

  it('merges coverage as two sums, not as an average of platform percentages', async () => {
    const report = await overview(working(), NOW);
    expect(report.totals.coverageBps).toBe(5_741);
  });

  it('reports the success rate as null when nothing arrived in the window', async () => {
    const empty = registryFor({}, { other: 'down' });
    expect((await overview(empty, NOW)).totals.webhookSuccessBps).toBeNull();
  });
});

describe('revenue', () => {
  it('reports list MRR and says plainly that history is not built yet', async () => {
    const report = await revenue(working(), '30d', NOW);
    // No prices are configured, so every subscription is unpriced.
    expect(report.listMrrMinor).toBe(0);
    expect(report.unpricedSubscriptions).toBe(4);
    expect(report.series).toBeNull();
    expect(report.seriesUnavailable).toContain('snapshot job');
    expect(report.range).toBe('30d');
  });

  it('degrades to the platforms it could read', async () => {
    const report = await revenue(degraded(), '7d', NOW);
    expect(report.partial).toBe(true);
    expect(report.missing).toEqual([{ platform: 'other', reason: 'connection refused' }]);
    expect(report.byPlatform).toHaveLength(1);
  });
});

describe('storeList', () => {
  it('lists, sorts and pages the merged set', async () => {
    const result = await storeList(working(), { filter: {}, sort: 'orders', cursor: 0, limit: 2 }, NOW);
    expect(result.total).toBe(7);
    expect(result.stores).toHaveLength(2);
    expect(result.stores[0]?.storeId).toBe('demo:1');
    expect(result.nextCursor).toBe(2);
  });

  it('filters to the stores that need attention', async () => {
    const result = await storeList(
      working(),
      { filter: { needsAttention: true }, sort: 'store', cursor: 0, limit: 50 },
      NOW,
    );
    // demo:7 is on an unknown plan code AND has never sent a webhook, so it is
    // silent too — the unknown plan is not why it is here, and the two are
    // deliberately independent.
    expect(result.stores.map((store) => store.storeId)).toEqual(['demo:2', 'demo:3', 'demo:7']);
  });

  it('filters by status and plan', async () => {
    const byStatus = await storeList(
      working(),
      { filter: { status: 'past_due' }, sort: 'store', cursor: 0, limit: 50 },
      NOW,
    );
    expect(byStatus.stores.map((s) => s.storeId)).toEqual(['demo:3']);
  });

  it('carries the gap into the count, so a partial total is never read as complete', async () => {
    const result = await storeList(degraded(), { filter: {}, sort: 'store', cursor: 0, limit: 50 }, NOW);
    expect(result.partial).toBe(true);
    expect(result.missing[0]?.platform).toBe('other');
  });
});

describe('storeDetail', () => {
  it('returns one store with its recent failures', async () => {
    const result = await storeDetail(working(), 'demo', 'demo:3', NOW);
    expect(result.kind).toBe('found');
    if (result.kind !== 'found') return;
    expect(result.detail.store.health.flags).toContain('past_due');
    expect(result.detail.recentFailures).toHaveLength(6);
  });

  it('distinguishes an unknown platform, an unreadable one, and a missing store', async () => {
    // Three different answers because they send an operator three different
    // places, and collapsing them into 404 sends them to the wrong one.
    expect((await storeDetail(working(), 'nope', 'demo:1', NOW)).kind).toBe('unknown_platform');
    expect((await storeDetail(working(), 'demo', 'demo:999', NOW)).kind).toBe('not_found');

    const unreadable = await storeDetail(degraded(), 'other', 'demo:1', NOW);
    expect(unreadable.kind).toBe('unavailable');
    expect(unreadable.kind === 'unavailable' && unreadable.reason).toBe('connection refused');
  });
});

describe('ingestionReport', () => {
  it('reports per-platform health and totals over the range', async () => {
    const report = await ingestionReport(working(), '24h', NOW);
    expect(report.totals).toMatchObject({ processed: 2, failed: 6, queueDepth: 1, stalled: 1 });
    expect(report.totals.successBps).toBe(2_500);
    expect(report.platforms[0]?.recentFailures.length).toBeGreaterThan(0);
  });

  it('degrades to the platforms it could read', async () => {
    const report = await ingestionReport(degraded(), '24h', NOW);
    expect(report.partial).toBe(true);
    expect(report.platforms).toHaveLength(1);
  });
});

describe('unknownPaymentMethodQueue', () => {
  it('ranks unmapped rails across platforms', async () => {
    const queue = await unknownPaymentMethodQueue(working());
    expect(queue.rows[0]).toMatchObject({ platform: 'demo', rawMethodLabel: 'tabby_installments', orders: 2 });
  });

  it('names the platform it could not read', async () => {
    const queue = await unknownPaymentMethodQueue(degraded());
    expect(queue.partial).toBe(true);
    expect(queue.missing[0]?.platform).toBe('other');
  });
});

describe('acknowledgeAlert', () => {
  it('records the session the middleware verified', async () => {
    const record = await acknowledgeAlert(
      portal.db,
      'k-actor',
      new Headers({ [SESSION_HEADER]: 'session-9' }),
      'looking into it',
      NOW,
    );
    expect(record).toMatchObject({ alertKey: 'k-actor', note: 'looking into it' });

    const rows = await portal.client.query<{ actor_session: string }>(
      `SELECT actor_session FROM alert_ack WHERE alert_key = 'k-actor'`,
    );
    expect(rows.rows[0]?.actor_session).toBe('session-9');
    await forget(portal.db, 'k-actor');
  });

  it('records an unattributed acknowledgement rather than inventing an actor', async () => {
    // The header is stripped for an unauthenticated request, so its absence
    // here means the session could not be established — and a made-up actor in
    // an audit log is worse than an honest blank.
    await acknowledgeAlert(portal.db, 'k-anon', new Headers(), null, NOW);
    const rows = await portal.client.query<{ actor_session: string }>(
      `SELECT actor_session FROM alert_ack WHERE alert_key = 'k-anon'`,
    );
    expect(rows.rows[0]?.actor_session).toBe('unattributed');
    await forget(portal.db, 'k-anon');
  });
});

describe('alertFeed', () => {
  const noAcks = async () => new Map();

  it('raises the alerts the seeded stores deserve', async () => {
    const feed = await alertFeed(working(), noAcks, NOW);
    const kinds = feed.alerts.map((alert) => `${alert.kind}:${alert.storeId ?? ''}`);
    expect(kinds).toContain('silent_store:demo:2');
    expect(kinds).toContain('failed_jobs:demo:3');
    expect(kinds).toContain('past_due:demo:3');
  });

  it('RAISES A STUCK BACKFILL, which needs the summary to carry backfill state', async () => {
    // It did not, once. The feed passed `null` and the alert could never fire.
    const feed = await alertFeed(working(), noAcks, NOW);
    expect(feed.alerts.map((alert) => alert.kind)).toContain('stuck_backfill');
  });

  it('treats an unreadable platform as an alert, not as an absence of alerts', async () => {
    const feed = await alertFeed(degraded(), noAcks, NOW);
    const unreachable = feed.alerts.find((alert) => alert.kind === 'platform_unreachable');
    expect(unreachable).toMatchObject({ platform: 'other', storeId: null });
    expect(feed.partial).toBe(true);
  });

  it('names the alert types that cannot be computed rather than omitting them', async () => {
    const feed = await alertFeed(working(), noAcks, NOW);
    expect(Object.keys(feed.unavailable)).toContain('signature_failures');
  });

  it('SHOWS THE ALERTS when the acknowledgement store cannot be read', async () => {
    // An operator in the middle of an incident needs the list. Losing the
    // "I have seen this" markers is a far smaller loss than losing the alerts,
    // and saying so is what stops a re-raised alert reading as a new problem.
    const feed = await alertFeed(
      working(),
      async () => {
        throw new Error('portal database unreachable');
      },
      NOW,
    );
    expect(feed.alerts.length).toBeGreaterThan(0);
    expect(feed.acksUnavailable).toBe('portal database unreachable');
    expect(feed.partial).toBe(true);
  });

  it('applies acknowledgements read from the portal database', async () => {
    await acknowledge(portal.db, 'silent_store:demo:demo:2', 'session-1', 'chasing', NOW);
    const feed = await alertFeed(working(), async () => activeAcks(portal.db, NOW), NOW);
    const silent = feed.alerts.find((alert) => alert.key === 'silent_store:demo:demo:2');
    expect(silent?.acknowledgedUntil).not.toBeNull();
    expect(feed.acksUnavailable).toBeNull();
    // Unacknowledged alerts sort first, so the acknowledged one is not at the top.
    expect(feed.alerts[0]?.acknowledgedUntil).toBeNull();
    await forget(portal.db, 'silent_store:demo:demo:2');
  });
});

describe('alert acknowledgements', () => {
  it('records who and when, and lets the same alert be acknowledged again', async () => {
    const earlier = new Date(NOW.getTime() - 3_600_000);
    await acknowledge(portal.db, 'k1', 'session-1', 'first', earlier);
    // Re-acknowledging must MOVE the clock. Ignoring the second would let an
    // alert acknowledged again today expire on yesterday's schedule and
    // resurface while the operator is still working on it.
    const second = await acknowledge(portal.db, 'k1', 'session-2', 'second', NOW);
    expect(second.acknowledgedAt).toBe(NOW.toISOString());

    const recent = await recentAcks(portal.db, 10);
    expect(recent.find((ack) => ack.alertKey === 'k1')?.note).toBe('second');
    await forget(portal.db, 'k1');
  });

  it('filters expired acknowledgements in SQL rather than loading them all', async () => {
    const old = new Date(NOW.getTime() - 25 * 3_600_000);
    await acknowledge(portal.db, 'k-old', 'session-1', null, old);
    await acknowledge(portal.db, 'k-new', 'session-1', null, NOW);

    const active = await activeAcks(portal.db, NOW);
    expect(active.has('k-new')).toBe(true);
    expect(active.has('k-old')).toBe(false);

    await forget(portal.db, 'k-old');
    await forget(portal.db, 'k-new');
  });
});
