import { toMinor, toPlatformId } from '@ghalla/contracts';
import type { Instant, PlatformId, SubscriptionStatus } from '@ghalla/contracts';
import { toCoverageBps } from '../queries/coverage';
import type { Coverage } from '../queries/coverage';
import type { BackfillState } from '../queries/ingestion';
import { activation, storeHealth } from '../queries/store-health';
import type { StoreFacts } from '../queries/store-health';
import type { PlatformStore } from '../queries/stores';
import type { SubscriptionRow } from '../queries/subscriptions';
import { FIXTURE_NOW_INSTANT, ago, ahead } from './clock';

/**
 * The store list, as the handoff draws it.
 *
 * Health flags and activation are NOT written down here — they are produced by
 * running each row's facts through `storeHealth` and `activation`, the same
 * functions the live path uses. That is the difference between a fixture and a
 * mock: a hand-written `flags: ['silent']` can claim a state the rules would
 * never actually produce, and the screen then renders a row that cannot exist.
 * Here, a row is silent because its last webhook really is 31 hours old.
 *
 * The consequence is worth knowing: changing a threshold in `store-health.ts`
 * changes these fixtures, and a test that pins the expected flags will fail.
 * That is the correct direction — the fixture follows the rule.
 */

interface StoreSpec {
  readonly platform: PlatformId;
  readonly platformStoreId: string;
  readonly timezone?: string;
  readonly installedAt: Instant;
  readonly uninstalledAt?: Instant | null;
  readonly status?: SubscriptionStatus | null;
  readonly planCode?: string;
  readonly periodStart?: Instant;
  readonly periodEnd?: Instant;
  readonly trialEndsAt?: Instant | null;
  /** Revenue in the coverage window, in halalas. */
  readonly revenueMinor?: number;
  /** Share of that revenue we can price, in basis points. */
  readonly coverageBps?: number | null;
  readonly ordersCount?: number;
  readonly dirtyBuckets?: number;
  readonly lastWebhookAt?: Instant | null;
  readonly failedJobs?: number;
  readonly backfill?: BackfillState | null;
  readonly ordersInPeriod?: number;
}

function coverageOf(spec: StoreSpec): Coverage | null {
  if (spec.coverageBps === null || spec.coverageBps === undefined) return null;
  const revenue = toMinor(spec.revenueMinor ?? 0);
  const covered = toMinor(Math.round((revenue * spec.coverageBps) / 10_000));
  return {
    revenueExVatMinor: revenue,
    coveredRevenueExVatMinor: covered,
    // Recomputed through the real function rather than echoed back, so a
    // fixture cannot claim a percentage its own two terms do not produce.
    coverageBps: toCoverageBps(covered, revenue),
    ordersCount: spec.ordersCount ?? 0,
    dirtyBuckets: spec.dirtyBuckets ?? 0,
  };
}

function subscriptionOf(spec: StoreSpec, storeId: string): SubscriptionRow | null {
  if (spec.status === null || spec.status === undefined) return null;
  return {
    storeId,
    planCode: spec.planCode ?? 'growth',
    effectivePlanCode: spec.planCode ?? 'growth',
    status: spec.status,
    currentPeriodStart: spec.periodStart ?? ago(12, 'd'),
    currentPeriodEnd: spec.periodEnd ?? ahead(18, 'd'),
    trialEndsAt: spec.trialEndsAt ?? null,
    lastReconciledAt: ago(9, 'h'),
    pendingPlanCode: null,
  };
}

function build(spec: StoreSpec): PlatformStore {
  const storeId = `${spec.platform}:${spec.platformStoreId}`;
  const facts: StoreFacts = {
    storeId,
    installedAt: spec.installedAt,
    uninstalledAt: spec.uninstalledAt ?? null,
    subscription: subscriptionOf(spec, storeId),
    coverage: coverageOf(spec),
    lastWebhookAt: spec.lastWebhookAt ?? null,
    failedJobs: spec.failedJobs ?? 0,
    backfill: spec.backfill ?? null,
    ordersInPeriod: spec.ordersInPeriod ?? 0,
    // No integration records this yet, so it is `null` for every fixture too —
    // the funnel's last step must demonstrate "not measured", not "nobody did".
    dashboardSession: null,
  };

  return {
    platform: spec.platform,
    storeId,
    platformStoreId: spec.platformStoreId,
    currency: 'SAR',
    timezone: spec.timezone ?? 'Asia/Riyadh',
    installedAt: facts.installedAt,
    uninstalledAt: facts.uninstalledAt,
    subscription: facts.subscription,
    coverage: facts.coverage,
    lastWebhookAt: facts.lastWebhookAt,
    failedJobs: facts.failedJobs,
    backfill: facts.backfill,
    ordersInPeriod: facts.ordersInPeriod,
    health: storeHealth(facts, FIXTURE_NOW_INSTANT),
    activation: activation(facts),
  };
}

const SALLA = toPlatformId('salla');
const ZID = toPlatformId('zid');

const complete = (items: number, at: Instant): BackfillState => ({
  status: 'complete',
  itemsFetched: items,
  startedAt: at,
  lastAdvancedAt: at,
});

/**
 * Fourteen stores covering every state the handoff asks to see: silent, over
 * cap, past due, stuck backfill, zero coverage, churned, and healthy.
 */
export const storeFixtures: readonly PlatformStore[] = [
  build({
    platform: SALLA,
    platformStoreId: '1305146709',
    installedAt: ago(177, 'd'),
    status: 'active',
    planCode: 'growth',
    revenueMinor: 41_820_00,
    coverageBps: 9_200,
    ordersCount: 4_182,
    ordersInPeriod: 1_262,
    // 31 hours, past the 24-hour threshold: this is the silent-store row.
    lastWebhookAt: ago(31, 'h'),
    backfill: complete(4_182, ago(177, 'd')),
  }),
  build({
    platform: SALLA,
    platformStoreId: '1188420031',
    installedAt: ago(65, 'd'),
    status: 'active',
    planCode: 'growth',
    revenueMinor: 29_040_00,
    coverageBps: 3_100,
    ordersCount: 2_904,
    ordersInPeriod: 918,
    lastWebhookAt: ago(2, 'h'),
    // Started nine days ago and still running: stuck.
    backfill: { status: 'running', itemsFetched: 1_806, startedAt: ago(9, 'd'), lastAdvancedAt: ago(9, 'h') },
  }),
  build({
    platform: SALLA,
    platformStoreId: '1740092255',
    installedAt: ago(230, 'd'),
    status: 'active',
    planCode: 'growth',
    revenueMinor: 117_400_00,
    coverageBps: 1_400,
    ordersCount: 11_740,
    ordersInPeriod: 3_910,
    lastWebhookAt: ago(4, 'm'),
    backfill: complete(11_740, ago(230, 'd')),
  }),
  build({
    platform: ZID,
    platformStoreId: '55210447',
    installedAt: ago(123, 'd'),
    status: 'past_due',
    planCode: 'growth',
    revenueMinor: 33_180_00,
    coverageBps: 900,
    ordersCount: 3_318,
    ordersInPeriod: 1_602,
    lastWebhookAt: ago(12, 'm'),
    backfill: complete(3_318, ago(123, 'd')),
  }),
  build({
    platform: SALLA,
    platformStoreId: '1902773641',
    installedAt: ago(2, 'd'),
    status: 'trialing',
    planCode: 'starter',
    trialEndsAt: ahead(12, 'd'),
    revenueMinor: 1_680_00,
    coverageBps: 0,
    ordersCount: 168,
    ordersInPeriod: 51,
    lastWebhookAt: ago(9, 'm'),
    backfill: complete(168, ago(2, 'd')),
  }),
  build({
    platform: ZID,
    platformStoreId: '55884120',
    installedAt: ago(1, 'd'),
    status: 'active',
    planCode: 'growth',
    revenueMinor: 7_420_00,
    coverageBps: 7_600,
    ordersCount: 742,
    ordersInPeriod: 742,
    lastWebhookAt: ago(1, 'm'),
    backfill: complete(742, ago(1, 'd')),
  }),
  build({
    platform: SALLA,
    platformStoreId: '1044918822',
    installedAt: ago(320, 'd'),
    status: 'active',
    planCode: 'scale',
    revenueMinor: 90_140_00,
    coverageBps: 8_800,
    ordersCount: 9_014,
    ordersInPeriod: 2_755,
    lastWebhookAt: ago(2, 'm'),
    backfill: complete(9_014, ago(320, 'd')),
  }),
  build({
    platform: SALLA,
    platformStoreId: '1993310884',
    installedAt: ago(2, 'h'),
    status: 'trialing',
    planCode: 'starter',
    trialEndsAt: ahead(14, 'd'),
    revenueMinor: 410_00,
    coverageBps: 0,
    ordersCount: 41,
    ordersInPeriod: 12,
    lastWebhookAt: ago(40, 's'),
    // Installed two hours ago, so this is running and NOT yet stuck — the guard
    // that stops every new install alerting on its first morning.
    backfill: { status: 'running', itemsFetched: 17, startedAt: ago(2, 'h'), lastAdvancedAt: ago(3, 'm') },
  }),
  build({
    platform: SALLA,
    platformStoreId: '1663092440',
    installedAt: ago(3, 'd'),
    status: 'trialing',
    planCode: 'starter',
    trialEndsAt: ahead(11, 'd'),
    revenueMinor: 2_140_00,
    coverageBps: 4_400,
    ordersCount: 214,
    ordersInPeriod: 64,
    lastWebhookAt: ago(6, 'm'),
    backfill: complete(214, ago(3, 'd')),
  }),
  build({
    platform: SALLA,
    platformStoreId: '1471003528',
    installedAt: ago(1, 'd'),
    status: 'trialing',
    planCode: 'growth',
    trialEndsAt: ahead(13, 'd'),
    revenueMinor: 960_00,
    coverageBps: 1_200,
    ordersCount: 96,
    ordersInPeriod: 96,
    lastWebhookAt: ago(3, 'm'),
    backfill: complete(96, ago(1, 'd')),
  }),
  build({
    platform: ZID,
    platformStoreId: '55043318',
    installedAt: ago(83, 'd'),
    status: 'past_due',
    planCode: 'growth',
    revenueMinor: 18_060_00,
    coverageBps: 2_100,
    ordersCount: 1_806,
    ordersInPeriod: 640,
    lastWebhookAt: ago(2, 'd'),
    backfill: complete(1_806, ago(83, 'd')),
  }),
  build({
    platform: SALLA,
    platformStoreId: '1220884471',
    installedAt: ago(208, 'd'),
    status: 'active',
    planCode: 'growth',
    revenueMinor: 74_550_00,
    coverageBps: 6_400,
    ordersCount: 7_455,
    ordersInPeriod: 1_684,
    lastWebhookAt: ago(1, 'm'),
    backfill: complete(7_455, ago(208, 'd')),
  }),
  build({
    platform: ZID,
    platformStoreId: '55771902',
    installedAt: ago(39, 'd'),
    uninstalledAt: ago(6, 'd'),
    status: 'canceled',
    planCode: 'starter',
    revenueMinor: 0,
    coverageBps: null,
    ordersCount: 0,
    ordersInPeriod: 0,
    lastWebhookAt: ago(6, 'd'),
    backfill: complete(0, ago(39, 'd')),
  }),
  build({
    platform: SALLA,
    platformStoreId: '1377205513',
    installedAt: ago(96, 'd'),
    uninstalledAt: ago(19, 'd'),
    status: 'expired',
    planCode: 'growth',
    revenueMinor: 12_400_00,
    coverageBps: 2_800,
    ordersCount: 1_240,
    ordersInPeriod: 0,
    lastWebhookAt: ago(19, 'd'),
    backfill: complete(1_240, ago(96, 'd')),
  }),
  build({
    platform: SALLA,
    platformStoreId: '1558230917',
    installedAt: ago(128, 'd'),
    status: 'active',
    planCode: 'growth',
    revenueMinor: 52_310_00,
    coverageBps: 8_100,
    ordersCount: 5_231,
    ordersInPeriod: 1_402,
    lastWebhookAt: ago(2, 'm'),
    failedJobs: 2,
    backfill: complete(5_231, ago(128, 'd')),
  }),
];
