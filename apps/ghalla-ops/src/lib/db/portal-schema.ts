import {
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { MONEY_PRECISION, MONEY_SCALE } from '@ghalla/persistence/money';

/**
 * The portal's OWN database. Nothing here is an integration's data.
 *
 * Two things live in this schema, and they are the two things the integration
 * databases structurally cannot provide.
 *
 * HISTORY. Every integration database holds current state and only current
 * state: a store that cancelled last month reports as `canceled` today and
 * reported as `active` in March, and nothing anywhere remembers March. MRR over
 * time, cohort retention and funnel trends are all questions about the past, so
 * the past has to be written down as it happens. That is what the snapshot
 * tables are — and it is why a gap in them is unrecoverable rather than merely
 * inconvenient.
 *
 * OPERATOR STATE. Alert acknowledgements and an audit log of every action
 * dispatched from the portal. The audit log is not paperwork: when something is
 * broken at 03:00 the first question is what has already been tried, and the
 * answer has to survive the tab that tried it.
 *
 * The conventions are the integration schema's, on purpose — money is
 * `numeric(14, 2)` read through the same codec, timestamps carry a zone, and
 * invariants are CHECK constraints rather than comments. A second set of habits
 * in a second database is how two halves of one system start disagreeing.
 *
 * What is NOT here: any foreign key to a store. Those rows live in another
 * database entirely, so `store_id` is opaque text and the pairing that
 * identifies a store is `(platform, store_id)`.
 */

const money = (name: string) => numeric(name, { precision: MONEY_PRECISION, scale: MONEY_SCALE });
const instant = (name: string) => timestamp(name, { withTimezone: true });
/**
 * PARENTHESISED, and that is not decoration.
 *
 * `AND` binds tighter than `OR`, so two unbracketed terms of this shape joined
 * with AND collapse into `A OR (B AND C) OR D` — an expression that is true
 * whenever its last term is, and therefore constrains nothing. The generated
 * SQL is where that was caught, which is the argument for reading it.
 */
const nonNegative = (column: AnyPgColumn) => sql`(${column} IS NULL OR ${column} >= 0)`;

/** Every count column at once, as a conjunction of the bracketed terms above. */
const allNonNegative = (columns: readonly AnyPgColumn[]) =>
  sql.join(columns.map(nonNegative), sql` AND `);

/**
 * Ties a text column to the tuple the code reads it back with, so there is one
 * list and not two. `sql.raw` is safe because these are compile-time constants
 * declared in this file, never input.
 */
const oneOf = (column: AnyPgColumn, values: readonly string[]) =>
  sql`${column} IN (${sql.raw(values.map((v) => `'${v}'`).join(', '))})`;

/**
 * Truncation asserted rather than assumed.
 *
 * `date_trunc` over a `timestamptz` is STABLE, not IMMUTABLE, and Postgres
 * refuses a CHECK built on it — so the value is converted to a zoneless UTC
 * timestamp and back, both of which are immutable. The constraint is worth the
 * awkwardness: the hour IS half the primary key, and an unaligned value would
 * quietly write a second row for the same hour instead of replacing the first.
 */
const truncatedToHour = (column: AnyPgColumn) =>
  sql`${column} = date_trunc('hour', ${column} AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`;

export const SNAPSHOT_STATUSES = ['ok', 'unreachable'] as const;
export const ADMIN_ACTION_STATUSES = ['dispatched', 'succeeded', 'failed'] as const;

/**
 * One row per platform per hour. The series MRR and queue-depth charts read.
 *
 * A row is written even when the platform could not be reached, with its
 * metrics NULL and `error` set. That distinction is the whole point: a MISSING
 * row means the snapshot job did not run, and a row with an error means it ran
 * and the platform was down. Those have different fixes, and a scheme that
 * simply skipped the failure would make them indistinguishable — which is the
 * same trap as a component that silently does nothing.
 */
export const platformSnapshot = pgTable(
  'platform_snapshot',
  {
    platform: text('platform').notNull(),
    // Half of the primary key, so a re-run inside the same hour REPLACES rather
    // than duplicates. An id the database minted would make every re-run a new
    // row and every chart double-count.
    capturedHour: instant('captured_hour').notNull(),
    status: text('status').notNull(),

    activeStores: integer('active_stores'),
    trialingStores: integer('trialing_stores'),
    pastDueStores: integer('past_due_stores'),
    canceledStores: integer('canceled_stores'),
    expiredStores: integer('expired_stores'),

    // LIST price, summed over the subscriptions this build can price. Not what
    // anyone was charged — see docs/0009 — which is why the name says list.
    listMrrMinor: money('list_mrr_minor'),
    // Subscriptions whose plan code this build does not recognise, excluded
    // from the sum above. Reported rather than swallowed: a plan published
    // after this deploy would otherwise show up as a quiet fall in MRR.
    unknownPlanSubscriptions: integer('unknown_plan_subscriptions'),

    // `live` only. A backfill is not merchant activity and counting it would
    // make every install look like a spike.
    ordersIngestedLive24h: integer('orders_ingested_live_24h'),

    // Numerator and denominator, never a rate. A stored percentage cannot be
    // aggregated across platforms without re-weighting, and the rollup that
    // forgets to re-weight is wrong in a way no test catches.
    webhooksProcessed24h: integer('webhooks_processed_24h'),
    webhooksFailed24h: integer('webhooks_failed_24h'),

    queueDepth: integer('queue_depth'),
    // Rows a worker is holding whose lock is older than the reaper's threshold.
    queueStalled: integer('queue_stalled'),

    error: text('error'),
    createdAt: instant('created_at').defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.platform, table.capturedHour] }),
    // The chart's only query: one platform, newest first.
    index('platform_snapshot_recent_idx').on(table.capturedHour),
    check('platform_snapshot_status_valid', oneOf(table.status, SNAPSHOT_STATUSES)),
    check('platform_snapshot_hour_aligned', truncatedToHour(table.capturedHour)),
    // Metrics and an error are mutually exclusive. Both halves are silent
    // failures otherwise: a row with neither is a chart gap nobody can explain,
    // and a row with both is a number derived from a failed read.
    check(
      'platform_snapshot_metrics_iff_ok',
      sql`(${table.status} = 'ok') = (${table.activeStores} IS NOT NULL)`,
    ),
    check('platform_snapshot_error_iff_unreachable', sql`(${table.status} = 'unreachable') = (${table.error} IS NOT NULL)`),
    check(
      'platform_snapshot_counts_positive',
      allNonNegative([
        table.activeStores,
        table.trialingStores,
        table.pastDueStores,
        table.canceledStores,
        table.expiredStores,
        table.unknownPlanSubscriptions,
        table.ordersIngestedLive24h,
        table.webhooksProcessed24h,
        table.webhooksFailed24h,
        table.queueDepth,
        table.queueStalled,
      ]),
    ),
  ],
);

/**
 * One row per store per day. Cohort retention and the activation funnel read it.
 *
 * Daily rather than hourly because the questions it answers are about weeks,
 * and an hourly row per store is 24x the volume for a resolution nothing plots.
 */
export const storeSnapshot = pgTable(
  'store_snapshot',
  {
    platform: text('platform').notNull(),
    // Opaque. The store lives in another database; this is text, not a key.
    storeId: text('store_id').notNull(),
    capturedDate: date('captured_date', { mode: 'string' }).notNull(),

    planCode: text('plan_code').notNull(),
    status: text('status').notNull(),
    // The subscription's own window, so `ordersInPeriod` can be read months
    // later without having to guess which window it counted.
    periodStart: instant('period_start'),
    periodEnd: instant('period_end'),
    ordersInPeriod: integer('orders_in_period'),

    // Coverage as its two terms, matching `order_profit` upstream, which keeps
    // the numerator and refuses to store the ratio for exactly this reason: an
    // average of per-store percentages is not the platform's percentage.
    coverageRevenueExVatMinor: money('coverage_revenue_ex_vat_minor'),
    coverageCoveredRevenueExVatMinor: money('coverage_covered_revenue_ex_vat_minor'),

    lastWebhookAt: instant('last_webhook_at'),
    backfillOrdersStatus: text('backfill_orders_status'),
    backfillOrdersStartedAt: instant('backfill_orders_started_at'),

    createdAt: instant('created_at').defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.platform, table.storeId, table.capturedDate] }),
    // Retention reads a whole day across every store; the store page reads one
    // store across every day. Two different leading columns, two indexes.
    index('store_snapshot_date_idx').on(table.capturedDate),
    index('store_snapshot_store_idx').on(table.platform, table.storeId, table.capturedDate),
    check('store_snapshot_orders_positive', nonNegative(table.ordersInPeriod)),
    // Covered revenue cannot exceed the revenue it is a share of.
    check(
      'store_snapshot_coverage_bounded',
      sql`${table.coverageCoveredRevenueExVatMinor} IS NULL
          OR ${table.coverageRevenueExVatMinor} IS NULL
          OR ${table.coverageCoveredRevenueExVatMinor} <= ${table.coverageRevenueExVatMinor}`,
    ),
  ],
);

/**
 * An acknowledged alert.
 *
 * Alerts themselves are NOT rows — they are a query over current state, so that
 * a problem which fixes itself stops being an alert without anything having to
 * delete it. What has to be durable is the operator saying "I have seen this",
 * and that is keyed by the alert's stable key so it survives recomputation.
 *
 * Expiry is READ TIME, from `acknowledged_at`, and there is no sweeper. A
 * persisting problem is meant to resurface after a day; a job that expires
 * acknowledgements is a job that can fail to run, and its failure mode is an
 * alert that stays silenced.
 */
export const alertAck = pgTable(
  'alert_ack',
  {
    // `silent_store:<platform>:<store id>`. Stable across recomputation, which
    // is what makes acknowledging a specific problem possible at all.
    alertKey: text('alert_key').primaryKey(),
    acknowledgedAt: instant('acknowledged_at').defaultNow().notNull(),
    // The session that acknowledged it. With a single shared access key this
    // cannot name a person — see docs/0009 — so it is a session fingerprint and
    // is named for what it actually is.
    actorSession: text('actor_session'),
    note: text('note'),
  },
  (table) => [index('alert_ack_acknowledged_idx').on(table.acknowledgedAt)],
);

/**
 * Every action the portal dispatched to an integration's admin API.
 *
 * Written BEFORE the call and updated after, which is the ordering that makes
 * it useful: a row still sitting at `dispatched` means the portal died between
 * asking and hearing back, and that is precisely the case where the operator
 * must not assume the action did not happen.
 *
 * `params` must never carry the integration's admin token. The token is how the
 * portal proves who it is; a copy of it in a log table is a credential with a
 * much wider blast radius than the table it sits in.
 */
export const adminActionLog = pgTable(
  'admin_action_log',
  {
    id: text('id').primaryKey(),
    // A session fingerprint, not a person. See `alert_ack.actor_session`.
    actorSession: text('actor_session').notNull(),
    platform: text('platform').notNull(),
    // NULL for a platform-wide action.
    storeId: text('store_id'),
    action: text('action').notNull(),
    params: jsonb('params').notNull(),

    status: text('status').notNull().default('dispatched'),
    // The integration's structured answer, whatever it was.
    result: jsonb('result'),
    error: text('error'),

    createdAt: instant('created_at').defaultNow().notNull(),
    completedAt: instant('completed_at'),
  },
  (table) => [
    // The audit view: newest first, optionally narrowed to one store.
    index('admin_action_log_created_idx').on(table.createdAt),
    index('admin_action_log_store_idx').on(table.platform, table.storeId, table.createdAt),
    // The 03:00 query: what did we fire off and never hear back about.
    index('admin_action_log_open_idx').on(table.createdAt).where(sql`${table.status} = 'dispatched'`),
    check('admin_action_log_status_valid', oneOf(table.status, ADMIN_ACTION_STATUSES)),
    // An action is finished if and only if it has a completion time. Without
    // this, a row can claim success while looking like it never returned.
    check(
      'admin_action_log_completed_iff_settled',
      sql`(${table.status} = 'dispatched') = (${table.completedAt} IS NULL)`,
    ),
  ],
);
