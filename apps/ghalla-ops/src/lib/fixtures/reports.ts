import { toMinor } from '@ghalla/contracts';
import type { Instant, PlatformId } from '@ghalla/contracts';
import { annualisedPrice, effectivePlanCode, isBilled, isPlanCode, toMonthlyRate } from '@ghalla/billing';
import { toCoverageBps } from '../queries/coverage';
import type { Coverage } from '../queries/coverage';
import { applyAcks, sortAlerts, storeAlerts, UNAVAILABLE_ALERTS } from '../queries/alerts';
import type { AlertFeed } from '../queries/alert-feed';
import { successRateBps } from '../queries/ingestion';
import type { FailedEvent, IngestionHealth } from '../queries/ingestion';
import type { IngestionReport, PlatformIngestion } from '../queries/ingestion-report';
import type { Overview, PlatformOverview } from '../queries/overview';
import type { PaymentQueue } from '../queries/payment-queue';
import type { RevenueReport } from '../queries/revenue';
import type { StoreDetailResult } from '../queries/store-detail';
import type { StoreListResult } from '../queries/store-list';
import { matchesFilter, paginate, sortStores } from '../queries/stores';
import type { PlatformStore, StoreFilter, StoreSort } from '../queries/stores';
import type { MrrBreakdown, PlanRevenue, StatusCounts } from '../queries/subscriptions';
import type { Range } from '../queries/window';
import type { StoreFacts } from '../queries/store-health';
import { FIXTURE_NOW_INSTANT, ago } from './clock';
import { storeFixtures } from './stores';

/**
 * Every report the console reads, assembled from `storeFixtures`.
 *
 * DERIVED rather than typed out, wherever the query layer exposes a pure
 * function to derive it with. The alert feed runs through `storeAlerts` and
 * `sortAlerts`; the store list through `matchesFilter`, `sortStores` and
 * `paginate`; MRR through `effectivePlanCode` and `annualisedPrice`. The point
 * is that a fixture cannot disagree with the rules — a sidebar badge counting
 * six alerts and a feed showing four is precisely the class of bug that makes
 * an operator stop trusting the console, and it is unrepresentable here.
 *
 * What IS typed out is what no fixture store can imply: webhook queue depths,
 * failed job rows and the per-platform ingestion counts. Those come from tables
 * this fixture set does not model, and inventing a store-shaped source for them
 * would be more fiction, not less.
 */

const SALLA = 'salla' as PlatformId;
const ZID = 'zid' as PlatformId;

export const FIXTURE_PLATFORMS: readonly PlatformId[] = [SALLA, ZID];

function storesOf(platform: PlatformId): readonly PlatformStore[] {
  return storeFixtures.filter((store) => store.platform === platform);
}

function factsOf(store: PlatformStore): StoreFacts {
  return {
    storeId: store.storeId,
    installedAt: store.installedAt,
    uninstalledAt: store.uninstalledAt,
    subscription: store.subscription,
    coverage: store.coverage,
    lastWebhookAt: store.lastWebhookAt,
    failedJobs: store.failedJobs,
    backfill: store.backfill,
    ordersInPeriod: store.ordersInPeriod,
    dashboardSession: store.activation.dashboardSession,
  };
}

/** Coverage across a set of stores: the two terms summed, divided once. */
function foldCoverage(stores: readonly PlatformStore[]): Coverage {
  let revenue = 0;
  let covered = 0;
  let orders = 0;
  let dirty = 0;
  for (const store of stores) {
    if (store.coverage === null) continue;
    revenue += store.coverage.revenueExVatMinor;
    covered += store.coverage.coveredRevenueExVatMinor;
    orders += store.coverage.ordersCount;
    dirty += store.coverage.dirtyBuckets;
  }
  return {
    revenueExVatMinor: toMinor(revenue),
    coveredRevenueExVatMinor: toMinor(covered),
    coverageBps: toCoverageBps(toMinor(covered), toMinor(revenue)),
    ordersCount: orders,
    dirtyBuckets: dirty,
  };
}

function foldStatuses(stores: readonly PlatformStore[]): StatusCounts {
  const tally = { active: 0, trialing: 0, pastDue: 0, canceled: 0, expired: 0, subscriptions: 0 };
  for (const store of stores) {
    const status = store.subscription?.status;
    if (status === undefined) continue;
    tally.subscriptions += 1;
    if (status === 'active') tally.active += 1;
    if (status === 'trialing') tally.trialing += 1;
    if (status === 'past_due') tally.pastDue += 1;
    if (status === 'canceled') tally.canceled += 1;
    if (status === 'expired') tally.expired += 1;
  }
  return tally;
}

/**
 * MRR from the fixture stores' own plan mix.
 *
 * Uses the same three functions the live query uses after its SQL —
 * `effectivePlanCode`, `isBilled`, `annualisedPrice` — and divides once at the
 * end for the same reason. Hand-writing a figure here would let the sidebar,
 * the overview and the revenue screen each show a different MRR for the same
 * fourteen stores.
 */
function foldMrr(stores: readonly PlatformStore[], at: Instant): MrrBreakdown {
  const byPlanCode = new Map<string, { stores: number; annualised: number }>();
  const unknownByPlan = new Map<string, number>();
  let billedStores = 0;

  for (const store of stores) {
    const subscription = store.subscription;
    if (subscription === null || !isBilled(subscription.status)) continue;
    billedStores += 1;

    const code = effectivePlanCode(
      {
        planCode: subscription.planCode,
        pendingPlanCode: subscription.pendingPlanCode,
        pendingPlanEffectiveAt: null,
      },
      at,
    );
    if (!isPlanCode(code)) {
      unknownByPlan.set(code, (unknownByPlan.get(code) ?? 0) + 1);
      continue;
    }
    const entry = byPlanCode.get(code) ?? { stores: 0, annualised: 0 };
    entry.stores += 1;
    entry.annualised += annualisedPrice(code);
    byPlanCode.set(code, entry);
  }

  const byPlan: PlanRevenue[] = [...byPlanCode.entries()]
    .map(([planCode, entry]) => ({
      planCode,
      stores: entry.stores,
      listMrrMinor: toMinor(toMonthlyRate(entry.annualised)),
    }))
    .sort((a, b) => b.listMrrMinor - a.listMrrMinor);

  const totalAnnualised = [...byPlanCode.values()].reduce((sum, entry) => sum + entry.annualised, 0);

  return {
    listMrrMinor: toMinor(toMonthlyRate(totalAnnualised)),
    listArrMinor: toMinor(totalAnnualised),
    billedStores,
    byPlan,
    unknownPlans: [...unknownByPlan.entries()].map(([planCode, stores]) => ({ planCode, stores })),
  };
}

// ------------------------------------------------------------- ingestion --

/**
 * Queue and outcome counts per platform. Typed out, not derived.
 *
 * Salla is healthy; Zid is the DEGRADED platform the handoff draws — a deep
 * queue, a stalled worker and a success rate in the low nineties. Both are
 * chosen so `successRateBps` lands on the figures the design shows, rather than
 * the rate being written down and the counts invented to suit.
 */
const INGESTION: Readonly<Record<string, IngestionHealth>> = {
  salla: {
    processed: 12_000,
    failed: 72,
    skipped: 318,
    pending: 1_204,
    processing: 6,
    stalled: 0,
    oldestPendingAt: ago(4, 'm'),
  },
  zid: {
    processed: 2_360,
    failed: 214,
    skipped: 90,
    pending: 8_430,
    processing: 4,
    stalled: 3,
    oldestPendingAt: ago(14, 'm'),
  },
};

const FAILED_EVENTS: readonly FailedEvent[] = [
  {
    id: 'zid:evt_88213004',
    storeId: 'zid:55210447',
    eventType: 'order.updated',
    rawEventType: 'order.status.updated',
    receivedAt: ago(11, 'm'),
    attempts: 3,
    lastError: 'ETIMEDOUT: connect ETIMEDOUT 10.4.2.11:443 after 10000ms',
  },
  {
    id: 'zid:evt_88212877',
    storeId: 'zid:55043318',
    eventType: 'order.updated',
    rawEventType: 'order.status.updated',
    receivedAt: ago(26, 'm'),
    attempts: 3,
    lastError: 'AdapterError[rate_limited]: 429 Too Many Requests, retry-after 60s',
  },
  {
    id: 'salla:evt_44190228',
    storeId: 'salla:1558230917',
    eventType: 'shipment.updated',
    rawEventType: 'order.shipment.updated',
    receivedAt: ago(1, 'h'),
    attempts: 3,
    lastError: 'ORDER_RECONCILIATION_FAILED: total 41850 != subtotal 36400 + shipping 1500 + vat 5460',
  },
  {
    id: 'zid:evt_88210441',
    storeId: 'zid:55210447',
    eventType: 'order.created',
    rawEventType: 'order.created',
    receivedAt: ago(2, 'h'),
    attempts: 3,
    lastError: 'AdapterError[reauth_required]: 401 invalid_grant — merchant must reconnect',
  },
  {
    id: 'salla:evt_44189903',
    storeId: 'salla:1740092255',
    eventType: 'product.updated',
    rawEventType: 'product.price.updated',
    receivedAt: ago(5, 'h'),
    attempts: 3,
    lastError: 'FEE_RULE_INVALID: minFeeMinor 900 > maxFeeMinor 600 for mada/checkout',
  },
];

// --------------------------------------------------------------- reports --

export function alertFeedFixture(acknowledged: ReadonlyMap<string, Instant> = new Map()): AlertFeed {
  const raised = storeFixtures.flatMap((store) =>
    storeAlerts(store.platform, factsOf(store), FIXTURE_NOW_INSTANT),
  );
  return {
    alerts: sortAlerts(applyAcks(raised, acknowledged, FIXTURE_NOW_INSTANT)),
    unavailable: UNAVAILABLE_ALERTS,
    acksUnavailable: null,
    partial: false,
    capturedAt: FIXTURE_NOW_INSTANT,
  };
}

/** The empty feed — state 1 of the five the handoff asks for. */
export function clearAlertFeedFixture(): AlertFeed {
  return { ...alertFeedFixture(), alerts: [] };
}

function platformOverviewOf(platform: PlatformId, stores: readonly PlatformStore[]): PlatformOverview {
  const ingestion = INGESTION[platform] as IngestionHealth;
  return {
    stores: stores.length,
    statuses: foldStatuses(stores),
    mrr: foldMrr(stores, FIXTURE_NOW_INSTANT),
    coverage: foldCoverage(stores),
    ingestion,
    ordersIngested24h: platform === SALLA ? 1_842 : 366,
  };
}

export function overviewFixture(stores: readonly PlatformStore[] = storeFixtures): Overview {
  const platforms = FIXTURE_PLATFORMS.map((platform) => ({
    platform,
    overview: platformOverviewOf(
      platform,
      stores.filter((store) => store.platform === platform),
    ),
  }));

  let annualised = 0;
  let processed = 0;
  let failed = 0;
  let revenue = 0;
  let covered = 0;
  for (const { overview } of platforms) {
    annualised += overview.mrr.listArrMinor;
    processed += overview.ingestion.processed;
    failed += overview.ingestion.failed;
    revenue += overview.coverage.revenueExVatMinor;
    covered += overview.coverage.coveredRevenueExVatMinor;
  }

  const statuses = foldStatuses(stores);

  return {
    totals: {
      stores: stores.length,
      active: statuses.active,
      trialing: statuses.trialing,
      pastDue: statuses.pastDue,
      listMrrMinor: toMinor(toMonthlyRate(annualised)),
      listArrMinor: toMinor(annualised),
      unknownPlanSubscriptions: 0,
      ordersIngested24h: platforms.reduce((sum, p) => sum + p.overview.ordersIngested24h, 0),
      queueDepth: platforms.reduce((sum, p) => sum + p.overview.ingestion.pending, 0),
      stalledJobs: platforms.reduce((sum, p) => sum + p.overview.ingestion.stalled, 0),
      webhookSuccessBps: successRateBps(processed, failed),
      coverageBps: revenue <= 0 ? null : Math.round((covered * 10_000) / revenue),
    },
    platforms,
    missing: [],
    partial: false,
    capturedAt: FIXTURE_NOW_INSTANT,
  };
}

/** State 5: one platform unreachable, the rest of the console still live. */
export function partialOverviewFixture(): Overview {
  const full = overviewFixture();
  const salla = full.platforms.filter((entry) => entry.platform === SALLA);
  const sallaStores = storesOf(SALLA);
  const statuses = foldStatuses(sallaStores);
  const annualised = salla.reduce((sum, entry) => sum + entry.overview.mrr.listArrMinor, 0);
  const ingestion = INGESTION['salla'] as IngestionHealth;
  const coverage = foldCoverage(sallaStores);

  return {
    totals: {
      stores: sallaStores.length,
      active: statuses.active,
      trialing: statuses.trialing,
      pastDue: statuses.pastDue,
      listMrrMinor: toMinor(toMonthlyRate(annualised)),
      listArrMinor: toMinor(annualised),
      unknownPlanSubscriptions: 0,
      ordersIngested24h: 1_842,
      queueDepth: ingestion.pending,
      stalledJobs: ingestion.stalled,
      webhookSuccessBps: successRateBps(ingestion.processed, ingestion.failed),
      coverageBps: coverage.coverageBps,
    },
    platforms: salla,
    missing: [
      {
        platform: ZID,
        reason: 'connect ECONNREFUSED 10.4.2.19:5432',
      },
    ],
    partial: true,
    capturedAt: FIXTURE_NOW_INSTANT,
  };
}

export interface StoreListArgs {
  readonly filter?: StoreFilter;
  readonly sort?: StoreSort;
  readonly cursor?: number;
  readonly limit?: number;
  readonly stores?: readonly PlatformStore[];
}

export function storeListFixture(args: StoreListArgs = {}): StoreListResult {
  const source = args.stores ?? storeFixtures;
  const filtered = source.filter((store) => matchesFilter(store, args.filter ?? {}));
  const page = paginate(
    sortStores(filtered, args.sort ?? 'orders'),
    args.cursor ?? 0,
    args.limit ?? 50,
  );
  return {
    stores: page.stores,
    total: page.total,
    nextCursor: page.nextCursor,
    missing: [],
    partial: false,
    capturedAt: FIXTURE_NOW_INSTANT,
  };
}

export function storeDetailFixture(platform: string, storeId: string): StoreDetailResult {
  const store = storeFixtures.find(
    (candidate) => candidate.platform === platform && candidate.storeId === storeId,
  );
  if (!FIXTURE_PLATFORMS.some((known) => known === platform)) return { kind: 'unknown_platform' };
  if (store === undefined) return { kind: 'not_found' };

  return {
    kind: 'found',
    detail: {
      platform: store.platform,
      store,
      recentFailures: FAILED_EVENTS.filter((event) => event.storeId === storeId),
      capturedAt: FIXTURE_NOW_INSTANT,
    },
  };
}

export function ingestionReportFixture(range: Range): IngestionReport {
  const platforms: readonly PlatformIngestion[] = FIXTURE_PLATFORMS.map((platform) => {
    const health = INGESTION[platform] as IngestionHealth;
    return {
      platform,
      health,
      successBps: successRateBps(health.processed, health.failed),
      recentFailures: FAILED_EVENTS.filter((event) => event.storeId.startsWith(`${platform}:`)),
    };
  });

  const processed = platforms.reduce((sum, entry) => sum + entry.health.processed, 0);
  const failed = platforms.reduce((sum, entry) => sum + entry.health.failed, 0);

  return {
    range,
    platforms,
    missing: [],
    totals: {
      processed,
      failed,
      queueDepth: platforms.reduce((sum, entry) => sum + entry.health.pending, 0),
      stalled: platforms.reduce((sum, entry) => sum + entry.health.stalled, 0),
      successBps: successRateBps(processed, failed),
    },
    partial: false,
    capturedAt: FIXTURE_NOW_INSTANT,
  };
}

export function revenueFixture(range: Range): RevenueReport {
  const byPlatform = FIXTURE_PLATFORMS.map((platform) => ({
    platform,
    mrr: foldMrr(storesOf(platform), FIXTURE_NOW_INSTANT),
  }));
  const annualised = byPlatform.reduce((sum, entry) => sum + entry.mrr.listArrMinor, 0);

  return {
    listMrrMinor: toMinor(toMonthlyRate(annualised)),
    listArrMinor: toMinor(annualised),
    billedStores: byPlatform.reduce((sum, entry) => sum + entry.mrr.billedStores, 0),
    unknownPlanSubscriptions: 0,
    byPlatform,
    missing: [],
    // Not a fixture decision: `RevenueReport.series` is typed `null`, because
    // integration databases hold only the present. The screen renders the
    // reason rather than a chart.
    series: null,
    seriesUnavailable:
      'MRR over time needs point-in-time history; it lands with the snapshot job that fills platform_snapshot',
    range,
    partial: false,
    capturedAt: FIXTURE_NOW_INSTANT,
  };
}

export function paymentQueueFixture(): PaymentQueue {
  const rows = [
    { storeId: 'salla:1740092255', instrument: 'unknown', rawMethodLabel: 'tabby_installments', orders: 412 },
    { storeId: 'salla:1305146709', instrument: 'unknown', rawMethodLabel: 'tamara_pay_later', orders: 268 },
    { storeId: 'zid:55210447', instrument: 'other', rawMethodLabel: 'stc_pay_wallet', orders: 173 },
    { storeId: 'salla:1044918822', instrument: 'unknown', rawMethodLabel: 'urpay', orders: 96 },
    { storeId: 'salla:1220884471', instrument: 'other', rawMethodLabel: 'bank_transfer_manual', orders: 74 },
    { storeId: 'zid:55884120', instrument: 'unknown', rawMethodLabel: 'apple_pay_mada', orders: 51 },
    { storeId: 'salla:1558230917', instrument: 'unknown', rawMethodLabel: 'mispay', orders: 33 },
    { storeId: 'salla:1188420031', instrument: 'other', rawMethodLabel: 'cod_partial_prepaid', orders: 21 },
    { storeId: 'zid:55043318', instrument: 'unknown', rawMethodLabel: 'nearpay_terminal', orders: 12 },
    { storeId: 'salla:1663092440', instrument: 'unknown', rawMethodLabel: 'gift_card_balance', orders: 4 },
  ].map((row) => ({
    ...row,
    platform: (row.storeId.startsWith('salla:') ? SALLA : ZID),
  }));

  return {
    rows: [...rows].sort((a, b) => b.orders - a.orders),
    missing: [],
    partial: false,
    capturedAt: FIXTURE_NOW_INSTANT,
  };
}

