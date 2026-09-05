import { isPaying, monthlyCapOf, planOf } from '@ghalla/billing';
import type { Instant } from '@ghalla/contracts';
import type { PlatformStore } from '../queries/stores';
import type { HealthFlag } from '../queries/store-health';
import type { IngestionHealth } from '../queries/ingestion';
import type { Alert, AlertKind } from '../queries/alerts';
import type { RevenueReport } from '../queries/revenue';
import type { PlanRevenue } from '../queries/subscriptions';

/**
 * The judgements a screen makes about a row, kept out of the markup.
 *
 * Everything here turns query output into something a component renders
 * directly — which severity a row is, what its health column says, how full its
 * order cap is. It lives in `lib` rather than in a component because each one
 * can be WRONG in a way a reader would not notice: a store that is silently
 * losing data rendered the same shade as one with slightly stale costs is a
 * defect you only find by reading the code, and here it is a table test.
 *
 * No metric is defined here. Every input is already computed by `lib/queries`;
 * this only decides how it reads.
 */

/**
 * Three levels, and the split is about what is being lost.
 *
 * BAD means data or money is going missing right now — a store that stopped
 * talking to us, a payment that did not collect, events dying in the queue.
 * WARN means the numbers are incomplete but nothing is bleeding: a backfill
 * that stalled, costs that cover too little revenue to trust a margin.
 *
 * Collapsing the two would be the more obvious design and it is the wrong one.
 * An operator scanning 312 rows needs "act now" to look different from "fix
 * this week", or the whole table reads as noise by Thursday.
 */
export type Severity = 'ok' | 'warn' | 'bad';

const CRITICAL: readonly HealthFlag[] = ['silent', 'past_due', 'jobs_failing'];

export function severityOf(flags: readonly HealthFlag[]): Severity {
  if (flags.length === 0) return 'ok';
  return flags.some((flag) => CRITICAL.includes(flag)) ? 'bad' : 'warn';
}

const FLAG_LABELS: Readonly<Record<HealthFlag, string>> = {
  silent: 'Silent',
  past_due: 'Past due',
  jobs_failing: 'Jobs failing',
  backfill_stuck: 'Backfill stuck',
  coverage_low: 'Low coverage',
};

/**
 * The health column's text: `Healthy`, `Silent`, or `Silent · past due`.
 *
 * Every flag is named rather than only the worst one. A store that is both
 * silent and past due is a different conversation from one that is only silent,
 * and showing the first flag alone hides the half that explains the other.
 * Ordered by `healthFlags`' own order so the column reads consistently down the
 * table instead of reordering per row.
 */
export function healthLabel(flags: readonly HealthFlag[]): string {
  if (flags.length === 0) return 'Healthy';
  const [first, ...rest] = flags;
  const head = FLAG_LABELS[first as HealthFlag];
  return rest.length === 0
    ? head
    : `${head} · ${rest.map((flag) => FLAG_LABELS[flag].toLowerCase()).join(' · ')}`;
}

export interface CapUsage {
  readonly used: number;
  /** `null` is unlimited — not zero, and not a missing plan. */
  readonly cap: number | null;
  /** `null` when unlimited or when the plan code is unknown to this build. */
  readonly percent: number | null;
  readonly overCap: boolean;
}

/**
 * How much of the plan's order allowance this period has used.
 *
 * Goes through `planOf` and `monthlyCapOf` from `@ghalla/billing` rather than
 * reading a number: the merchant's own usage banner is computed from those same
 * two functions, and a second rule here would eventually disagree with the
 * screen the merchant is looking at.
 *
 * An unknown plan code yields `null`, never `0`. A rollback to an image that
 * predates a plan must not render every store on it as being at 0% of nothing.
 */
export function capUsage(store: PlatformStore): CapUsage {
  const used = store.ordersInPeriod;
  const code = store.subscription?.effectivePlanCode ?? null;
  const plan = code === null ? null : planOf(code);
  if (plan === null) return { used, cap: null, percent: null, overCap: false };

  const cap = monthlyCapOf(plan);
  if (cap === null || cap <= 0) return { used, cap: null, percent: null, overCap: false };

  return {
    used,
    cap,
    percent: Math.round((used / cap) * 100),
    // Strictly greater, matching `usageStatus`: a store on exactly its cap has
    // had everything it paid for.
    overCap: used > cap,
  };
}

export interface StorePresentation {
  readonly severity: Severity;
  /** The health column's text. Names every problem, not only the worst. */
  readonly label: string;
  readonly cap: CapUsage;
}

/**
 * How one store row reads, combining the two things that can be wrong with it.
 *
 * `HealthFlag` deliberately has no `over_cap` member, and that is correct in
 * the domain: exceeding a soft cap is not a fault, it is a merchant growing
 * past what they pay for. But it IS something an operator wants to see in the
 * table, so it enters here — at the presentation layer — rather than being
 * added to a health model where it would start alerting.
 *
 * Its severity is WARN even alongside nothing else, and BAD only in company:
 * a store over its cap is a sales conversation, while a store over its cap with
 * costs on a third of its revenue is being billed on numbers we cannot stand
 * behind.
 */
export function storePresentation(store: PlatformStore): StorePresentation {
  const cap = capUsage(store);
  const flags = store.health.flags;
  const fromFlags = severityOf(flags);

  /*
   * A store that uninstalled reads as CHURNED and severity `ok`, and the second
   * half of that is deliberate even though it looks wrong.
   *
   * `isLive` already excludes a departed store from every health rule, so it
   * carries no flags — correctly, because there is nothing to fix. Painting the
   * row red anyway would put it outside "needs attention only", which filters
   * on `health.healthy`, and an operator would have a red row that the red-row
   * filter refuses to show. Churn is a business outcome, not an incident: the
   * status chip says CANCELED and the row reads muted.
   */
  if (store.uninstalledAt !== null) return { severity: 'ok', label: 'Churned', cap };

  const severity: Severity =
    fromFlags === 'bad' ? 'bad' : cap.overCap && fromFlags === 'warn' ? 'bad' : cap.overCap ? 'warn' : fromFlags;

  const parts: string[] = [];
  if (cap.overCap) parts.push('Over cap');
  for (const flag of flags) {
    // Zero is worth its own word. "Low coverage" on a store with no costs at
    // all understates it: there is nothing to be low, and the margin on that
    // store is entirely fallback.
    if (flag === 'coverage_low' && store.coverage?.coverageBps === 0) {
      parts.push('No coverage');
      continue;
    }
    parts.push(FLAG_LABELS[flag]);
  }

  if (parts.length === 0) return { severity, label: 'Healthy', cap };
  const [head, ...rest] = parts;
  return {
    severity,
    label: rest.length === 0 ? (head as string) : `${head as string} · ${rest.map((p) => p.toLowerCase()).join(' · ')}`,
    cap,
  };
}

export interface SavedViewCounts {
  readonly trialing: number;
  readonly overCap: number;
  readonly pastDue: number;
  readonly lowCoverage: number;
  readonly silent: number;
}

/** The saved-view chips above the store table. Counted over the WHOLE list, never the page. */
export function savedViewCounts(stores: readonly PlatformStore[]): SavedViewCounts {
  let trialing = 0;
  let overCap = 0;
  let pastDue = 0;
  let lowCoverage = 0;
  let silent = 0;

  for (const store of stores) {
    if (store.subscription?.status === 'trialing') trialing += 1;
    if (store.subscription?.status === 'past_due') pastDue += 1;
    if (capUsage(store).overCap) overCap += 1;
    if (store.health.flags.includes('coverage_low')) lowCoverage += 1;
    if (store.health.flags.includes('silent')) silent += 1;
  }

  return { trialing, overCap, pastDue, lowCoverage, silent };
}

export interface FunnelStep {
  readonly step: string;
  /** `null` when the signal behind this step is not collected — never `0`. */
  readonly count: number | null;
  /** Share of the first step, `null` when this step is unknown. */
  readonly share: number | null;
  /** Change from the previous KNOWN step, as a percentage of the first. */
  readonly drop: number | null;
}

/**
 * Installed → Backfill complete → Cost data entered → Activated → Paid.
 *
 * `Activated` comes back `null` and that is the honest answer: it depends on
 * whether the merchant has ever opened their dashboard, no integration records
 * that yet, and `Activation.activated` is `null` for every store because of it.
 * Rendering the step as `0` would draw a wall at the end of the funnel and send
 * somebody looking for a product problem that does not exist.
 */
export function activationFunnel(stores: readonly PlatformStore[]): readonly FunnelStep[] {
  const installed = stores.length;
  const backfill = stores.filter((store) => store.activation.backfillComplete).length;
  const costed = stores.filter((store) => store.activation.coverageAboveThreshold).length;
  const activated = stores.every((store) => store.activation.activated === null)
    ? null
    : stores.filter((store) => store.activation.activated === true).length;
  const paid = stores.filter(
    (store) => store.subscription !== null && isPaying(store.subscription.status),
  ).length;

  const raw: readonly (readonly [string, number | null])[] = [
    ['Installed', installed],
    ['Backfill complete', backfill],
    ['Cost data entered', costed],
    ['Activated', activated],
    ['Paid', paid],
  ];

  let previous: number | null = installed;
  return raw.map(([step, count], index) => {
    const share = count === null || installed === 0 ? null : Math.round((count / installed) * 100);
    const drop =
      index === 0 || count === null || previous === null || installed === 0
        ? null
        : Math.round(((count - previous) / installed) * 100);
    if (count !== null) previous = count;
    return { step, count, share, drop };
  });
}

/**
 * Newest installs first.
 *
 * Excludes stores that have already left. A merchant who installed on Tuesday
 * and uninstalled on Wednesday is not a recent install worth celebrating in the
 * corner of the overview, and leaving them in makes the list read better than
 * the week actually went.
 */
export function recentInstalls(
  stores: readonly PlatformStore[],
  limit: number,
): readonly PlatformStore[] {
  return [...stores]
    .filter((store) => store.uninstalledAt === null)
    .sort((a, b) => b.installedAt.localeCompare(a.installedAt))
    .slice(0, limit);
}

/**
 * A store that has left, with the departure date narrowed to non-null.
 *
 * Its own type so the churn table can read `uninstalledAt` without a null check
 * that the filter has already made impossible — a guard no input can fail,
 * sitting where a reader expects a real one.
 */
export interface ChurnedStore extends PlatformStore {
  readonly uninstalledAt: Instant;
}

/** Most recent departures first. Only stores that actually left. */
export function recentChurns(
  stores: readonly PlatformStore[],
  limit: number,
): readonly ChurnedStore[] {
  return stores
    .filter((store): store is ChurnedStore => store.uninstalledAt !== null)
    .toSorted((a, b) => b.uninstalledAt.localeCompare(a.uninstalledAt))
    .slice(0, limit);
}

/** Whole months between two instants, floored. The churn table's tenure column. */
export function tenureMonths(installedAt: string, leftAt: string): number {
  const from = new Date(installedAt);
  const to = new Date(leftAt);
  const months = (to.getFullYear() - from.getFullYear()) * 12 + (to.getMonth() - from.getMonth());
  return Math.max(0, to.getDate() < from.getDate() ? months - 1 : months);
}

export interface FunnelBand {
  readonly label: string;
  readonly count: number;
  /** Share of everything received, `null` when nothing arrived. */
  readonly share: number | null;
}

/**
 * The webhook path as a funnel: what arrived, and what happened to it.
 *
 * `skipped` is its own band rather than folded into either success or failure.
 * An event this adapter does not handle was seen and dismissed, which is a
 * different fact from one that was processed and a very different fact from one
 * that died — and hiding it inside "processed" would make a platform sending us
 * mostly events we ignore look perfectly healthy.
 *
 * The denominator is everything RESOLVED in the window, not the queue: pending
 * events have not failed, they have not arrived at an outcome yet.
 */
export function webhookFunnel(health: IngestionHealth): readonly FunnelBand[] {
  const resolved = health.processed + health.failed + health.skipped;
  const share = (count: number): number | null =>
    resolved === 0 ? null : Math.round((count * 100) / resolved);

  return [
    { label: 'Resolved', count: resolved, share: resolved === 0 ? null : 100 },
    { label: 'Processed', count: health.processed, share: share(health.processed) },
    { label: 'Skipped', count: health.skipped, share: share(health.skipped) },
    { label: 'Failed', count: health.failed, share: share(health.failed) },
  ];
}

// ---------------------------------------------------------------- alerts --

export interface AlertPresentation {
  readonly severity: Severity;
  /** The word on the chip: CRITICAL, HIGH, BILLING. */
  readonly badge: string;
  readonly title: string;
  /** A single character for the glyph tile. Never the only signal — the chip says it in words. */
  readonly glyph: string;
}

/**
 * How each alert kind reads, and how urgently.
 *
 * `BILLING` exists as its own badge rather than being folded into HIGH because
 * it is a different job: a past-due subscription is answered by an email, a
 * stuck backfill by a worker restart, and an operator triaging at 09:00 sorts
 * by what they are about to do rather than by a severity number.
 *
 * Every kind is listed explicitly — no default branch — so adding a member to
 * `ALERT_KINDS` fails to compile here rather than rendering as a blank row.
 */
const ALERT_PRESENTATION: Readonly<Record<AlertKind, Omit<AlertPresentation, 'title'> & { title: string }>> = {
  silent_store: { severity: 'bad', badge: 'CRITICAL', title: 'No webhooks received', glyph: '!' },
  platform_unreachable: {
    severity: 'bad',
    badge: 'CRITICAL',
    title: 'Platform database unreachable',
    glyph: '!',
  },
  stuck_backfill: { severity: 'warn', badge: 'HIGH', title: 'Backfill stuck', glyph: '~' },
  failed_jobs: { severity: 'warn', badge: 'HIGH', title: 'Events failing', glyph: '~' },
  past_due: { severity: 'warn', badge: 'BILLING', title: 'Payment past due', glyph: '$' },
};

export function alertPresentation(alert: Alert): AlertPresentation {
  const base = ALERT_PRESENTATION[alert.kind];
  // An acknowledged alert keeps its badge and loses its urgency. It stays in
  // the list — an operator who silenced something at 03:00 needs to find it at
  // 09:00 — but it must not draw the eye of somebody scanning for what is
  // still broken.
  return alert.acknowledgedUntil === null ? base : { ...base, severity: 'ok' };
}

// -------------------------------------------------------------- platform --

/**
 * Below this, a platform's webhook path is DEGRADED rather than live.
 *
 * 95%. Chosen because a one-in-twenty failure rate is already a merchant a day
 * getting a wrong number on a busy platform, and because the alternative —
 * alerting on any failure at all — makes the indicator useless within a week.
 */
export const DEGRADED_SUCCESS_BPS = 9_500;

export interface PlatformState {
  /** `neutral` is a real answer here: a platform with no traffic is neither well nor unwell. */
  readonly tone: Severity | 'neutral';
  readonly label: string;
}

/**
 * The word on a platform card, in priority order.
 *
 * Stalled workers outrank a poor success rate: a stalled row means the reaper
 * is not running, which will keep getting worse on its own, while a dip in the
 * success rate may already be over. And a platform with NO traffic reads
 * `QUIET`, never `LIVE` — `successRateBps` returns `null` rather than 100% for
 * exactly this reason, and painting a silent integration green is how it goes
 * unnoticed for a week.
 */
export function platformState(health: IngestionHealth, successBps: number | null): PlatformState {
  if (health.stalled > 0) return { tone: 'bad', label: 'Attention' };
  if (successBps === null) return { tone: 'neutral', label: 'Quiet' };
  if (successBps < DEGRADED_SUCCESS_BPS) return { tone: 'warn', label: 'Degraded' };
  return { tone: 'ok', label: 'Live' };
}

// ----------------------------------------------------------- saved views --

/**
 * The chips above the store table.
 *
 * Three of these — over cap, low coverage, silent — are NOT expressible through
 * `StoreFilter`, which the API layer defines as platform, status, plan and
 * needsAttention. Rather than widen that contract for a UI convenience, they
 * narrow the list this screen already loaded. The cost is honest and worth
 * stating: a view only sees the page it was applied to, so on more stores than
 * one page holds these become "of the loaded rows" rather than "of all stores".
 */
export const STORE_VIEWS = ['trialing', 'over_cap', 'past_due', 'low_coverage', 'silent'] as const;
export type StoreView = (typeof STORE_VIEWS)[number];

export function isStoreView(value: string): value is StoreView {
  return (STORE_VIEWS as readonly string[]).includes(value);
}

export const STORE_VIEW_LABELS: Readonly<Record<StoreView, string>> = {
  trialing: 'Trialing',
  over_cap: 'Over cap',
  past_due: 'Past due',
  low_coverage: 'Low coverage',
  silent: 'Silent',
};

export function applyStoreView(
  stores: readonly PlatformStore[],
  view: StoreView | null,
): readonly PlatformStore[] {
  if (view === null) return stores;
  switch (view) {
    case 'trialing':
      return stores.filter((store) => store.subscription?.status === 'trialing');
    case 'past_due':
      return stores.filter((store) => store.subscription?.status === 'past_due');
    case 'over_cap':
      return stores.filter((store) => capUsage(store).overCap);
    case 'low_coverage':
      return stores.filter((store) => store.health.flags.includes('coverage_low'));
    case 'silent':
      return stores.filter((store) => store.health.flags.includes('silent'));
  }
}

/**
 * The filter field, over the identifiers we actually have.
 *
 * The handoff's search is by merchant NAME, and no name exists in the schema —
 * so this matches the platform's own store id and the platform slug instead.
 * Case-insensitive and a plain substring rather than a fuzzy match: an operator
 * pasting an id from a log wants that row, not the seven rows near it.
 */
export function filterByIdentifier(
  stores: readonly PlatformStore[],
  query: string,
): readonly PlatformStore[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return stores;
  return stores.filter(
    (store) =>
      store.platformStoreId.toLowerCase().includes(needle) ||
      store.platform.toLowerCase().includes(needle) ||
      store.storeId.toLowerCase().includes(needle),
  );
}

// --------------------------------------------------------------- revenue --

/**
 * Per-plan MRR across every platform, for the "by plan" bars.
 *
 * Sums the per-platform per-plan figures, each of which `mrr()` has already
 * rounded to a monthly rate. That rounds once per (plan, platform) pair rather
 * than once overall, so this can differ from the headline MRR by a few halalas
 * — the chart's own total is therefore NOT used as the headline anywhere, and
 * the report's `listMrrMinor` is. Getting per-plan annualised figures out of the
 * query layer would fix it properly, and it is not worth widening the contract
 * for a bar chart.
 */
export function mergePlanRevenue(report: RevenueReport): readonly PlanRevenue[] {
  const byPlan = new Map<string, { stores: number; listMrrMinor: number }>();
  for (const { mrr } of report.byPlatform) {
    for (const plan of mrr.byPlan) {
      const entry = byPlan.get(plan.planCode) ?? { stores: 0, listMrrMinor: 0 };
      entry.stores += plan.stores;
      entry.listMrrMinor += plan.listMrrMinor;
      byPlan.set(plan.planCode, entry);
    }
  }
  return [...byPlan.entries()]
    .map(([planCode, entry]) => ({
      planCode,
      stores: entry.stores,
      listMrrMinor: entry.listMrrMinor as PlanRevenue['listMrrMinor'],
    }))
    .sort((a, b) => b.listMrrMinor - a.listMrrMinor);
}
