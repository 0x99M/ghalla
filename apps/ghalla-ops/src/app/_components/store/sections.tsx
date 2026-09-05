import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { COVERAGE_LOW_BPS } from '../../../lib/queries/store-health';
import type { FailedEvent } from '../../../lib/queries/ingestion';
import type { StoreDetail } from '../../../lib/queries/store-detail';
import type { PlatformStore } from '../../../lib/queries/stores';
import { storePresentation } from '../../../lib/ui/presentation';
import { NO_VALUE, OPERATOR_TIME_ZONE, bpsToPercent, clampBarWidth, count, minorToRiyalsExact } from '../../../lib/ui/format';
import { cn } from '../../../lib/ui/cn';
import { Bar, Card, CardBody, CardHeader, Chip, Divider, Kicker, Row, StatusDot } from '../ui/primitives';
import { Unavailable } from '../ui/states';
import { TimeStamp } from '../ui/stamp';

const STATUS_TONE = {
  active: 'ok',
  trialing: 'neutral',
  past_due: 'bad',
  canceled: 'neutral',
  expired: 'neutral',
} as const;

/**
 * The header, and the one place both clocks are shown together.
 *
 * The store's own timezone owns its business-date boundary — a Riyadh evening
 * order belongs to that Riyadh day — while every relative time on this console
 * is the operator's. Showing one without the other is how an incident timeline
 * ends up an hour wrong, so both are named here rather than assumed anywhere.
 */
export function StoreHeader({ detail, now }: { readonly detail: StoreDetail; readonly now: Date }) {
  // `StoreDetail` keeps the platform beside the summary rather than inside it,
  // because a summary is read from ONE platform's database and has no reason to
  // name it. The presentation helpers work on the merged shape, so it is joined
  // back here rather than duplicating the rules for the un-merged one.
  const store: PlatformStore = { ...detail.store, platform: detail.platform };
  const look = storePresentation(store);
  const status = store.subscription?.status ?? null;

  return (
    <Card>
      <CardBody className="flex flex-col gap-3">
        <div className="flex items-center gap-3">
          <Link
            href="/stores"
            className="flex size-[26px] items-center justify-center rounded-chip-lg border border-line text-muted hover:text-ink"
            aria-label="Back to stores"
          >
            <ArrowLeft size={14} strokeWidth={2} aria-hidden />
          </Link>
          <h2 className="font-mono text-section-lg font-semibold">{store.platformStoreId}</h2>
          {status === null ? null : <Chip tone={STATUS_TONE[status]}>{status.replace('_', ' ')}</Chip>}
          {store.subscription === null ? null : (
            <Chip tone="accent">{store.subscription.effectivePlanCode}</Chip>
          )}
          <span className="flex items-center gap-[6px] text-meta-lg">
            <StatusDot tone={look.severity} />
            <span className={cn(look.severity === 'ok' ? 'text-muted' : 'font-semibold')}>{look.label}</span>
          </span>
        </div>

        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-meta-lg text-muted">
          <span className="capitalize">{store.platform}</span>
          <span>
            installed <TimeStamp at={store.installedAt} now={now} zone={store.timezone} suffix="ago" />
          </span>
          <span>{store.currency}</span>
          {/* Both zones, labelled. Never one. */}
          <span>
            store {store.timezone} · operator {OPERATOR_TIME_ZONE}
          </span>
          {store.uninstalledAt === null ? null : (
            <span className="font-semibold text-bad">
              uninstalled <TimeStamp at={store.uninstalledAt} now={now} suffix="ago" />
            </span>
          )}
        </div>
      </CardBody>
    </Card>
  );
}

export function SubscriptionCard({ detail, now }: { readonly detail: StoreDetail; readonly now: Date }) {
  const subscription = detail.store.subscription;

  return (
    <Card>
      <CardHeader title="Subscription" meta={subscription === null ? 'none' : subscription.planCode} />
      {subscription === null ? (
        <CardBody>
          <p className="text-cell-lg text-muted">
            No subscription row. The store has installed but its first billing webhook has not arrived.
          </p>
        </CardBody>
      ) : (
        <CardBody className="flex flex-col gap-[9px]">
          <Row
            label="Period"
            value={
              <>
                <TimeStamp at={subscription.currentPeriodStart} now={now} /> →{' '}
                <TimeStamp at={subscription.currentPeriodEnd} now={now} />
              </>
            }
          />
          <Row
            label="Trial ends"
            value={
              subscription.trialEndsAt === null ? (
                <span className="text-muted">{NO_VALUE}</span>
              ) : (
                <TimeStamp at={subscription.trialEndsAt} now={now} />
              )
            }
          />
          <Row
            label="Last reconciled"
            value={<TimeStamp at={subscription.lastReconciledAt} now={now} suffix="ago" />}
          />
          <Row
            label="Pending change"
            value={
              subscription.pendingPlanCode === null ? (
                <span className="text-muted">none</span>
              ) : (
                // An agreed downgrade still bills at the tier the merchant paid
                // for until the period they paid for runs out.
                <span className="font-semibold text-warn">→ {subscription.pendingPlanCode} at period end</span>
              )
            }
          />
          <Divider className="my-1" />
          <Unavailable
            what="Plan history"
            reason="the portal reads current subscription state; a history of plan changes needs the snapshot job"
          />
        </CardBody>
      )}
    </Card>
  );
}

/**
 * Backfill and the failures this store produced.
 *
 * The per-store received/processed/failed triple the handoff draws is NOT here:
 * `IngestionHealth` is computed per platform, and there is no per-store
 * equivalent in the query layer. What is real per store is the 24-hour failed
 * count, the last webhook, the backfill cursor, and the failed events
 * themselves — so those are shown and the rest says why it is missing.
 */
export function IngestionCard({ detail, now }: { readonly detail: StoreDetail; readonly now: Date }) {
  const { store } = detail;
  const backfill = store.backfill;
  const stuck = store.health.flags.includes('backfill_stuck');

  return (
    <Card>
      <CardHeader
        title="Ingestion"
        meta="orders backfill · last 24h"
        action={stuck ? <Chip tone="warn">Stuck</Chip> : null}
      />
      <CardBody className="flex flex-col gap-[10px]">
        <Row
          label="Last webhook"
          value={<TimeStamp at={store.lastWebhookAt} now={now} suffix="ago" />}
        />
        <Row
          label="Failed events (24h)"
          value={<span className={store.failedJobs > 0 ? 'text-bad' : ''}>{count(store.failedJobs)}</span>}
        />

        <Divider className="my-1" />

        {backfill === null ? (
          <p className="text-cell-lg text-muted">No backfill has been started for this store.</p>
        ) : (
          <div className="flex flex-col gap-[6px]">
            <div className="flex items-baseline justify-between text-cell-lg">
              <span className="text-muted">Backfill</span>
              <span className={cn('font-semibold', stuck && 'text-warn')}>
                {backfill.status} · {count(backfill.itemsFetched)} fetched
              </span>
            </div>
            {/*
              A bar with no total behind it would be a fabricated percentage:
              `backfill_cursors` records what has been fetched, never how much
              there is to fetch. The bar therefore shows ACTIVITY — how recently
              the cursor advanced — and says so.
            */}
            <Bar
              width={clampBarWidth(backfill.status === 'complete' ? 100 : stuck ? 100 : 40)}
              tone={backfill.status === 'complete' ? 'ok' : stuck ? 'warn' : 'info'}
            />
            <div className="flex items-baseline justify-between text-meta text-muted">
              <span>
                started <TimeStamp at={backfill.startedAt} now={now} suffix="ago" />
              </span>
              <span>
                last advanced <TimeStamp at={backfill.lastAdvancedAt} now={now} suffix="ago" />
              </span>
            </div>
          </div>
        )}
      </CardBody>
    </Card>
  );
}

/**
 * Whether the margins on this store's dashboard mean anything.
 *
 * Cost coverage is REVENUE-WEIGHTED, and the label says so, because "80% of
 * SKUs have costs" and "80% of revenue is covered" are different numbers and
 * only the second one answers the question. A merchant can price every
 * long-tail SKU and none of the three products that are the business.
 */
export function DataQualityCard({ detail }: { readonly detail: StoreDetail }) {
  const coverage = detail.store.coverage;
  const bps = coverage?.coverageBps ?? null;
  const atRisk = bps !== null && bps < COVERAGE_LOW_BPS;

  return (
    <Card>
      <CardHeader
        title="Data quality"
        meta="cost coverage, revenue-weighted · trailing 30 days"
        action={atRisk ? <Chip tone="bad">Churn risk</Chip> : null}
      />
      <CardBody className="flex flex-col gap-3">
        <div>
          <Kicker>Revenue we can price</Kicker>
          <div className="mt-1 flex items-baseline gap-3">
            <span
              className={cn(
                'text-figure font-extrabold tracking-figure',
                bps === null ? 'text-muted' : atRisk ? 'text-bad' : '',
              )}
            >
              {bpsToPercent(bps)}
            </span>
            {coverage === null ? null : (
              <span className="text-meta text-muted">
                {minorToRiyalsExact(coverage.coveredRevenueExVatMinor)} of{' '}
                {minorToRiyalsExact(coverage.revenueExVatMinor)} SAR ex-VAT
              </span>
            )}
          </div>
          <Bar
            className="mt-2"
            width={clampBarWidth(bps === null ? 0 : bps / 100)}
            tone={bps === null ? 'neutral' : atRisk ? 'bad' : bps < 7_000 ? 'warn' : 'ok'}
          />
        </div>

        {coverage === null ? (
          <p className="text-cell-lg text-muted">
            No revenue in the window, so coverage is unknown rather than bad.
          </p>
        ) : (
          <div className="flex flex-col gap-[9px]">
            <Row label="Orders in window" value={count(coverage.ordersCount)} />
            <Row
              label="Rollups awaiting rebuild"
              value={
                <span className={coverage.dirtyBuckets > 0 ? 'text-warn' : ''}>
                  {count(coverage.dirtyBuckets)}
                </span>
              }
            />
          </div>
        )}

        <Unavailable
          what="SKUs missing cost"
          reason="needs a per-SKU cost join the portal does not run; the integration owns that list"
        />
      </CardBody>
    </Card>
  );
}

/** The store's own failed events. Narrowed in SQL, newest first. */
export function FailuresCard({
  failures,
  now,
}: {
  readonly failures: readonly FailedEvent[];
  readonly now: Date;
}) {
  return (
    <Card>
      <CardHeader title="Failed events" meta={`${String(failures.length)} in the dead-letter state`} />
      {failures.length === 0 ? (
        <CardBody>
          <p className="text-cell-lg text-muted">Nothing has failed for this store.</p>
        </CardBody>
      ) : (
        <ul>
          {failures.map((event) => (
            <li key={event.id} className="border-b border-rule px-[14px] py-[10px] last:border-b-0">
              <div className="flex items-baseline gap-3">
                <span className="text-cell-lg font-bold">{event.eventType}</span>
                <span className="font-mono text-meta text-muted">{event.rawEventType}</span>
                <span className="ml-auto text-meta text-muted">
                  {count(event.attempts)} attempts · <TimeStamp at={event.receivedAt} now={now} suffix="ago" />
                </span>
              </div>
              {event.lastError === null ? null : (
                <p className="mt-[5px] rounded-chip-lg bg-subtle px-2 py-[5px] font-mono text-meta break-words text-bad">
                  {event.lastError}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
