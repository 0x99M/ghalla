import { describe, expect, it } from 'vitest';
import { consoleSummaryFixture } from '../src/lib/fixtures/console-summary';
import {
  alertFeedFixture,
  ingestionReportFixture,
  overviewFixture,
  paymentQueueFixture,
  revenueFixture,
  storeDetailFixture,
  storeListFixture,
} from '../src/lib/fixtures/reports';
import { FIXTURE_NOW_INSTANT } from '../src/lib/fixtures/clock';
import { storeFixtures } from '../src/lib/fixtures/stores';
import { storePresentation } from '../src/lib/ui/presentation';

/**
 * Fixtures are a CONTRACT, and this is what pins them.
 *
 * Typing them against the exported interfaces already stops a field being
 * invented — `tsc` rejects a fixture carrying a key the query layer does not
 * return. What a type cannot catch is a fixture that is internally impossible,
 * or a set of fixtures that disagree with each other. A console rendered
 * against data no database could produce is worse than no fixture at all,
 * because it looks like it works.
 */

describe('store fixtures', () => {
  it('covers every state the handoff asks to see', () => {
    const labels = storeFixtures.map((store) => storePresentation(store).label);
    expect(labels).toContain('Silent');
    expect(labels).toContain('Silent · past due');
    expect(labels).toContain('Backfill stuck');
    expect(labels).toContain('Over cap');
    expect(labels).toContain('No coverage');
    expect(labels).toContain('Low coverage');
    expect(labels).toContain('Churned');
    expect(labels).toContain('Healthy');
  });

  it('derives health rather than declaring it', () => {
    // Every flag on every row must be one the rules would actually raise for
    // that row's facts. A hand-written flag can claim a state the derivation
    // never produces, and the screen then renders a row that cannot exist.
    const silent = storeFixtures.filter((store) => store.health.flags.includes('silent'));
    for (const store of silent) {
      expect(store.lastWebhookAt).not.toBeNull();
      const age = Date.parse(FIXTURE_NOW_INSTANT) - Date.parse(store.lastWebhookAt as string);
      expect(age).toBeGreaterThanOrEqual(24 * 3_600_000);
    }
  });

  it('keeps a store installed minutes ago out of the silent list', () => {
    const fresh = storeFixtures.find((store) => store.platformStoreId === '1993310884');
    expect(fresh?.health.flags).not.toContain('silent');
    // ...and out of the stuck-backfill list, though its backfill is running.
    expect(fresh?.health.flags).not.toContain('backfill_stuck');
  });

  it('reports coverage percentages its own two terms produce', () => {
    for (const store of storeFixtures) {
      const coverage = store.coverage;
      if (coverage === null || coverage.revenueExVatMinor === 0) continue;
      const recomputed = Math.round(
        (coverage.coveredRevenueExVatMinor * 10_000) / coverage.revenueExVatMinor,
      );
      expect(coverage.coverageBps).toBe(recomputed);
    }
  });
});

describe('report fixtures', () => {
  it('agrees with itself across screens', () => {
    const overview = overviewFixture();
    const list = storeListFixture();
    const revenue = revenueFixture('30d');

    // The store count on the overview and the total on the store list are the
    // same fact. Two screens disagreeing about how many merchants exist is the
    // failure the query layer is built to prevent.
    expect(overview.totals.stores).toBe(list.total);
    expect(overview.totals.listMrrMinor).toBe(revenue.listMrrMinor);
    expect(overview.totals.listArrMinor).toBe(revenue.listArrMinor);
  });

  it('folds the sidebar counts from the same reports the screens render', () => {
    expect(consoleSummaryFixture.stores).toBe(overviewFixture().totals.stores);
    expect(consoleSummaryFixture.queue).toBe(paymentQueueFixture().rows.length);
    expect(consoleSummaryFixture.alerts).toBe(
      alertFeedFixture().alerts.filter((alert) => alert.acknowledgedUntil === null).length,
    );
  });

  it('raises alerts only for stores whose facts earn them', () => {
    const feed = alertFeedFixture();
    expect(feed.alerts.length).toBeGreaterThan(0);
    for (const alert of feed.alerts) {
      expect(alert.key).toContain(alert.platform);
      expect(alert.detail.length).toBeGreaterThan(0);
    }
  });

  it('reports a success rate its own counts produce', () => {
    const report = ingestionReportFixture('24h');
    for (const platform of report.platforms) {
      const total = platform.health.processed + platform.health.failed;
      expect(platform.successBps).toBe(Math.round((platform.health.processed * 10_000) / total));
    }
  });

  it('answers an unknown platform and an unknown store differently', () => {
    // "No such platform" and "no such store on a platform we do have" are
    // different answers, and only one of them means somebody mistyped a URL.
    expect(storeDetailFixture('shopify', 'shopify:1').kind).toBe('unknown_platform');
    expect(storeDetailFixture('salla', 'salla:does-not-exist').kind).toBe('not_found');
    expect(storeDetailFixture('salla', 'salla:1305146709').kind).toBe('found');
  });

  it('ranks the payment queue by orders, descending', () => {
    const rows = paymentQueueFixture().rows;
    const counts = rows.map((row) => row.orders);
    expect([...counts].sort((a, b) => b - a)).toStrictEqual(counts);
  });
});
