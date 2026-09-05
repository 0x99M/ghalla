import type { IngestionReport } from '../../../lib/queries/ingestion-report';
import type { FailedEvent } from '../../../lib/queries/ingestion';
import { UNAVAILABLE_ALERTS } from '../../../lib/queries/alerts';
import { platformState, webhookFunnel } from '../../../lib/ui/presentation';
import { bpsToPercent, clampBarWidth, count } from '../../../lib/ui/format';
import { cn } from '../../../lib/ui/cn';
import { Bar, Card, CardBody, CardHeader, Chip, Figure, Kicker, StatusDot } from '../ui/primitives';
import { Unavailable } from '../ui/states';
import { TimeStamp } from '../ui/stamp';
import { StoreRef } from '../ui/store-ref';

/**
 * The five figures at the top of the health screen.
 *
 * Three are real counts over `webhook_events`. Two — dropped-stale and
 * signature failures — have no source at all, and they say so rather than
 * showing a confident zero. That distinction is the whole design of this
 * screen: a zero next to "signature failures" is a claim that verification is
 * passing, and what is actually true is that a rejected delivery is never
 * written down, so nobody could tell either way.
 */
export function HealthStats({ report }: { readonly report: IngestionReport }) {
  const resolved = report.totals.processed + report.totals.failed;

  return (
    <div className="grid grid-cols-5 gap-3">
      <Stat label="Events resolved" value={count(resolved)} note={`${report.range} window`} />
      <Stat label="Processed" value={count(report.totals.processed)} tone="ok" />
      <Stat
        label="Failed"
        value={count(report.totals.failed)}
        tone={report.totals.failed > 0 ? 'bad' : 'neutral'}
        note="dead-lettered until replayed"
      />
      <Stat
        label="Queue depth"
        value={count(report.totals.queueDepth)}
        note={`${count(report.totals.stalled)} stalled`}
        tone={report.totals.stalled > 0 ? 'bad' : 'neutral'}
      />
      <Stat
        label="Success rate"
        value={bpsToPercent(report.totals.successBps, 1)}
        note={report.totals.successBps === null ? 'nothing arrived' : 'processed ÷ resolved'}
        tone={report.totals.successBps === null ? 'neutral' : report.totals.successBps < 9_500 ? 'warn' : 'ok'}
      />
    </div>
  );
}

function Stat({
  label,
  value,
  note,
  tone = 'neutral',
}: {
  readonly label: string;
  readonly value: string;
  readonly note?: string;
  readonly tone?: 'neutral' | 'ok' | 'warn' | 'bad';
}) {
  return (
    <Card className="px-[13px] py-3">
      <Kicker>{label}</Kicker>
      <Figure
        size="sm"
        className={cn(
          'mt-[3px]',
          tone === 'ok' && 'text-ok',
          tone === 'warn' && 'text-warn',
          tone === 'bad' && 'text-bad',
        )}
      >
        {value}
      </Figure>
      {note === undefined ? null : <p className="mt-[3px] text-meta text-muted">{note}</p>}
    </Card>
  );
}

/** Per-platform queues and the webhook funnel, side by side. */
export function PlatformHealth({ report, now }: { readonly report: IngestionReport; readonly now: Date }) {
  return (
    <div className="grid grid-cols-2 gap-3">
      {report.platforms.map((entry) => {
        const state = platformState(entry.health, entry.successBps);
        const bands = webhookFunnel(entry.health);
        const total = bands[0]?.count ?? 0;

        return (
          <Card key={entry.platform}>
            <CardHeader
              title={<span className="capitalize">{entry.platform}</span>}
              meta={`${report.range} window`}
              action={
                <span className="flex items-center gap-2">
                  <StatusDot tone={state.tone} />
                  <Chip tone={state.tone}>{state.label}</Chip>
                </span>
              }
            />
            <CardBody className="flex flex-col gap-3">
              <div className="grid grid-cols-3 gap-2">
                <Mini label="Pending" value={count(entry.health.pending)} />
                <Mini label="Processing" value={count(entry.health.processing)} />
                <Mini
                  label="Stalled"
                  value={count(entry.health.stalled)}
                  tone={entry.health.stalled > 0 ? 'bad' : 'neutral'}
                />
              </div>

              <div className="flex flex-col gap-[7px]">
                <Kicker>Webhook path</Kicker>
                {bands.slice(1).map((band) => (
                  <div key={band.label}>
                    <div className="flex items-baseline justify-between text-cell">
                      <span className="text-muted">{band.label}</span>
                      <span className="font-semibold">
                        {count(band.count)}
                        <span className="ml-2 text-meta text-muted">
                          {band.share === null ? '—' : `${String(band.share)}%`}
                        </span>
                      </span>
                    </div>
                    <Bar
                      className="mt-1"
                      height={6}
                      width={clampBarWidth(total === 0 ? 0 : (band.count / total) * 100)}
                      tone={band.label === 'Failed' ? 'bad' : band.label === 'Skipped' ? 'warn' : 'ok'}
                    />
                  </div>
                ))}
              </div>

              <p className="text-meta text-muted">
                Oldest queued <TimeStamp at={entry.health.oldestPendingAt} now={now} suffix="ago" />
              </p>
            </CardBody>
          </Card>
        );
      })}
    </div>
  );
}

function Mini({
  label,
  value,
  tone = 'neutral',
}: {
  readonly label: string;
  readonly value: string;
  readonly tone?: 'neutral' | 'bad';
}) {
  return (
    <div className="rounded-chip-lg bg-subtle px-[9px] py-[7px]">
      <div className="text-kicker font-bold tracking-caps uppercase text-muted">{label}</div>
      <div className={cn('mt-[2px] text-cell-lg font-extrabold', tone === 'bad' && 'text-bad')}>{value}</div>
    </div>
  );
}

/** The triage list. Newest first, because the newest failure is the one still happening. */
export function FailedJobsTable({
  report,
  now,
}: {
  readonly report: IngestionReport;
  readonly now: Date;
}) {
  const rows: readonly (FailedEvent & { readonly platform: string })[] = report.platforms.flatMap((entry) =>
    entry.recentFailures.map((failure) => ({ ...failure, platform: entry.platform })),
  );

  return (
    <Card>
      <CardHeader title="Failed jobs" meta={`${String(rows.length)} newest across platforms`} />
      {rows.length === 0 ? (
        <CardBody>
          <p className="text-cell-lg text-muted">Nothing in the dead-letter state.</p>
        </CardBody>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-cell-lg">
            <thead>
              <tr className="bg-subtle text-left text-kicker tracking-caps text-muted uppercase">
                <th scope="col" className="px-[14px] py-[9px] font-bold">Job</th>
                <th scope="col" className="px-[14px] py-[9px] font-bold">Store</th>
                <th scope="col" className="px-[14px] py-[9px] text-right font-bold">Attempts</th>
                <th scope="col" className="px-[14px] py-[9px] text-right font-bold">Last</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="border-b border-rule align-top last:border-b-0">
                  <td className="px-[14px] py-[9px]">
                    <span className="block font-semibold">{row.eventType}</span>
                    {row.lastError === null ? null : (
                      <span className="mt-[3px] block max-w-[62ch] font-mono text-meta break-words text-bad">
                        {row.lastError}
                      </span>
                    )}
                  </td>
                  <td className="px-[14px] py-[9px]">
                    <StoreRef
                      platform={row.platform}
                      platformStoreId={row.storeId.split(':')[1] ?? row.storeId}
                      storeId={row.storeId}
                    />
                  </td>
                  <td className="px-[14px] py-[9px] text-right font-semibold">{count(row.attempts)}</td>
                  <td className="px-[14px] py-[9px] text-right text-muted">
                    <TimeStamp at={row.receivedAt} now={now} suffix="ago" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

/** What this screen is designed to show and cannot, with the reason for each. */
export function HealthGaps() {
  return (
    <div className="grid grid-cols-3 gap-3">
      <Unavailable
        what="Queue depth over time"
        reason="needs point-in-time history; it lands with the snapshot job that fills platform_snapshot"
      />
      <Unavailable what="Signature failures" reason={UNAVAILABLE_ALERTS.signature_failures} />
      <Unavailable what="Nightly reconciliation trend" reason={UNAVAILABLE_ALERTS.reconciliation_spike} />
      <Unavailable
        what="Dropped stale events"
        reason="the stale-event guard discards before persisting, so a dropped event leaves no row to count"
      />
      <Unavailable
        what="Platform API error rate"
        reason="adapter HTTP outcomes are not recorded in any table the portal can read"
      />
      <Unavailable
        what="429 rate"
        reason="rate-limit responses are handled inside the adapter and never persisted"
      />
    </div>
  );
}
