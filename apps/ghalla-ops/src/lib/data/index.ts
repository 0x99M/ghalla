import { cache } from 'react';
import { getAggregateCache } from '../cache';
import { getPortalDb } from '../db/portal-db';
import { getRegistry } from '../platforms';
import { activeAcks } from '../portal/alert-acks';
import { alertFeed } from '../queries/alert-feed';
import { consoleSummary } from '../queries/console-summary';
import { ingestionReport } from '../queries/ingestion-report';
import { overview } from '../queries/overview';
import { unknownPaymentMethodQueue } from '../queries/payment-queue';
import { revenue } from '../queries/revenue';
import { storeDetail } from '../queries/store-detail';
import { storeList } from '../queries/store-list';
import type { AlertFeed } from '../queries/alert-feed';
import type { ConsoleSummary } from '../queries/console-summary';
import type { IngestionReport } from '../queries/ingestion-report';
import type { Overview } from '../queries/overview';
import type { PaymentQueue } from '../queries/payment-queue';
import type { RevenueReport } from '../queries/revenue';
import type { StoreDetailResult } from '../queries/store-detail';
import type { StoreListQuery, StoreListResult } from '../queries/store-list';
import type { Range } from '../queries/window';
import { consoleSummaryFixture } from '../fixtures/console-summary';
import {
  alertFeedFixture,
  clearAlertFeedFixture,
  ingestionReportFixture,
  overviewFixture,
  partialOverviewFixture,
  paymentQueueFixture,
  revenueFixture,
  storeDetailFixture,
  storeListFixture,
} from '../fixtures/reports';
import { NO_FLAGS } from '../fixtures/flags';
import type { FixtureFlags } from '../fixtures/flags';
import { usingFixtures } from './source';

/**
 * The ONE place a screen gets data from.
 *
 * Two jobs, and they are why this layer exists rather than pages calling
 * `lib/queries` directly. It is where the fixture switch lives, so moving to
 * live data is one environment variable rather than an edit in every page. And
 * every accessor is wrapped in React's `cache`, which memoises per REQUEST — so
 * the console layout and the page inside it can both ask for the alert feed and
 * the databases are read once. Without it, a layout that shows a badge would
 * double every query on every screen.
 *
 * The 60-second `AggregateCache` sits underneath and does a different job: it
 * survives ACROSS requests, and it is what the refresh button clears.
 *
 * The fixture flags are arguments rather than ambient state. `cache` keys on
 * them, so two screens asking with different flags get different answers
 * instead of whichever ran first.
 */

const fixtures = (): boolean => usingFixtures(process.env);

export const getOverview = cache(async (flags: FixtureFlags = NO_FLAGS): Promise<Overview> => {
  if (fixtures()) {
    // `railState: 'failed'` degrades the overview to a genuinely PARTIAL read —
    // one platform missing, with a driver error attached — rather than only
    // painting a section red. The five states the handoff asks for include a
    // section failing while the rest stays live, and that is the shape it
    // actually takes here.
    if (flags.railState === 'failed') return partialOverviewFixture();
    return overviewFixture(flags.zeroStores ? [] : undefined);
  }
  const now = new Date();
  return getAggregateCache().read('overview', now.getTime(), async () => overview(getRegistry(), now));
});

export const getAlertFeed = cache(async (flags: FixtureFlags = NO_FLAGS): Promise<AlertFeed> => {
  if (fixtures()) return flags.alertsClear || flags.zeroStores ? clearAlertFeedFixture() : alertFeedFixture();
  const now = new Date();
  return getAggregateCache().read('alerts', now.getTime(), async () =>
    alertFeed(getRegistry(), async () => activeAcks(getPortalDb(), now), now),
  );
});

export const getPaymentQueue = cache(async (): Promise<PaymentQueue> => {
  if (fixtures()) return paymentQueueFixture();
  const now = new Date();
  return getAggregateCache().read('payment-queue', now.getTime(), async () =>
    unknownPaymentMethodQueue(getRegistry()),
  );
});

export const getStoreList = cache(
  async (query: StoreListQuery, flags: FixtureFlags = NO_FLAGS): Promise<StoreListResult> => {
    if (fixtures()) {
      return storeListFixture({
        filter: query.filter,
        sort: query.sort,
        cursor: query.cursor,
        limit: query.limit,
        ...(flags.zeroStores ? { stores: [] } : {}),
      });
    }
    return storeList(getRegistry(), query, new Date());
  },
);

export const getStoreDetail = cache(
  async (platform: string, storeId: string): Promise<StoreDetailResult> => {
    if (fixtures()) return storeDetailFixture(platform, storeId);
    // Never cached, deliberately — see `storeDetail`. This is the screen
    // somebody opens right after doing something about a store, and a cached
    // answer shows the state before the fix.
    return storeDetail(getRegistry(), platform, storeId, new Date());
  },
);

export const getIngestionReport = cache(async (range: Range): Promise<IngestionReport> => {
  if (fixtures()) return ingestionReportFixture(range);
  const now = new Date();
  return getAggregateCache().read(`health:${range}`, now.getTime(), async () =>
    ingestionReport(getRegistry(), range, now),
  );
});

export const getRevenue = cache(async (range: Range): Promise<RevenueReport> => {
  if (fixtures()) return revenueFixture(range);
  const now = new Date();
  return getAggregateCache().read(`revenue:${range}`, now.getTime(), async () =>
    revenue(getRegistry(), range, now),
  );
});

/**
 * The sidebar's counts.
 *
 * Folded from three reports rather than queried, so a badge can never disagree
 * with the screen it links to — and, because those accessors are
 * request-memoised, a page that also renders one of them pays for it once.
 */
export const getConsoleSummary = cache(async (): Promise<ConsoleSummary> => {
  if (fixtures()) return consoleSummaryFixture;

  const [overviewReport, alerts, queue] = await Promise.all([
    getOverview(),
    getAlertFeed(),
    getPaymentQueue(),
  ]);
  return consoleSummary(overviewReport, alerts, queue);
});
