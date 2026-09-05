import type { Instant } from '@ghalla/contracts';
import { UNAVAILABLE_ALERTS } from '../../../lib/queries/alerts';
import type { Overview } from '../../../lib/queries/overview';
import { bpsToPercent, count } from '../../../lib/ui/format';
import { platformState } from '../../../lib/ui/presentation';
import { successRateBps } from '../../../lib/queries/ingestion';
import { Card, Chip, Divider, Figure, Kicker, StatusDot } from '../ui/primitives';
import { Unavailable } from '../ui/states';
import { TimeStamp } from '../ui/stamp';

/**
 * One card per platform, plus the two cross-cutting ones.
 *
 * Driven by `overview.platforms` rather than a hard-coded Salla/Zid pair, which
 * is the brief's own test of the abstraction: adding a platform must be an
 * environment variable and a registry entry, and this strip has to grow with it
 * without an edit.
 *
 * The handoff's fourth card is a nightly-reconciliation trend. There is nothing
 * to draw it from — the integration counts corrections as a metric rather than
 * as rows the portal can read — so it says so instead of showing an empty
 * chart, which would read as "no corrections" rather than "not measured".
 */
export function HealthStrip({ report, now }: { readonly report: Overview; readonly now: Date }) {
  const stalled = report.totals.stalledJobs;

  return (
    <div className="grid grid-cols-4 gap-3">
      {report.platforms.map(({ platform, overview }) => {
        const success = successRateBps(overview.ingestion.processed, overview.ingestion.failed);
        const state = platformState(overview.ingestion, success);
        return (
          <Card key={platform} className="rounded-card-lg px-[13px] py-3">
            <div className="flex items-center gap-[7px]">
              <StatusDot tone={state.tone} />
              <span className="text-title font-extrabold capitalize">{platform}</span>
              <Chip tone={state.tone} className="ml-auto">
                {state.label}
              </Chip>
            </div>

            <div className="mt-[11px]">
              <Kicker>Webhook 24h</Kicker>
              <Figure size="sm" className="mt-[2px]">
                {bpsToPercent(success, 1)}
              </Figure>
            </div>

            <Divider className="my-[10px]" />

            <dl className="flex items-baseline justify-between text-meta">
              <div>
                <dt className="text-muted">Queue</dt>
                <dd className="mt-[2px] font-bold">{count(overview.ingestion.pending)}</dd>
              </div>
              <div>
                <dt className="text-muted">Failed</dt>
                <dd
                  className={`mt-[2px] font-bold ${overview.ingestion.failed > 0 ? 'text-bad' : ''}`}
                >
                  {count(overview.ingestion.failed)}
                </dd>
              </div>
              <div>
                <dt className="text-muted">Stalled</dt>
                <dd className={`mt-[2px] font-bold ${overview.ingestion.stalled > 0 ? 'text-bad' : ''}`}>
                  {count(overview.ingestion.stalled)}
                </dd>
              </div>
            </dl>
          </Card>
        );
      })}

      <Card className="rounded-card-lg px-[13px] py-3">
        <div className="flex items-center gap-[7px]">
          <StatusDot tone={stalled > 0 ? 'bad' : 'ok'} />
          <span className="text-title font-extrabold">Workers</span>
          <Chip tone={stalled > 0 ? 'bad' : 'ok'} className="ml-auto">
            {stalled > 0 ? 'Attention' : 'OK'}
          </Chip>
        </div>

        <div className="mt-[11px]">
          <Kicker>Queue depth</Kicker>
          <Figure size="sm" className="mt-[2px]">
            {count(report.totals.queueDepth)}
          </Figure>
        </div>

        <Divider className="my-[10px]" />

        <dl className="flex items-baseline justify-between text-meta">
          <div>
            <dt className="text-muted">Stalled</dt>
            <dd className={`mt-[2px] font-bold ${stalled > 0 ? 'text-bad' : ''}`}>{count(stalled)}</dd>
          </div>
          <div>
            <dt className="text-muted">Orders 24h</dt>
            <dd className="mt-[2px] font-bold">{count(report.totals.ordersIngested24h)}</dd>
          </div>
          <div className="text-right">
            <dt className="text-muted">Oldest queued</dt>
            <dd className="mt-[2px] font-bold">
              <TimeStamp at={oldestPending(report)} now={now} />
            </dd>
          </div>
        </dl>
      </Card>

      <Unavailable what="Nightly reconciliation" reason={UNAVAILABLE_ALERTS.reconciliation_spike} />
    </div>
  );
}

/** The oldest thing still waiting anywhere. `null` when every queue is empty. */
function oldestPending(report: Overview): Instant | null {
  let oldest: Instant | null = null;
  for (const { overview } of report.platforms) {
    const candidate = overview.ingestion.oldestPendingAt;
    if (candidate === null) continue;
    if (oldest === null || candidate < oldest) oldest = candidate;
  }
  return oldest;
}
