import { getAlertFeed, getOverview, getStoreList } from '../../../lib/data';
import { usingFixtures } from '../../../lib/data/source';
import { parseFixtureFlags } from '../../../lib/fixtures/flags';
import { successRateBps } from '../../../lib/queries/ingestion';
import { activationFunnel, alertPresentation, platformState } from '../../../lib/ui/presentation';
import { NO_VALUE, bpsToPercent, count, minorToRiyals } from '../../../lib/ui/format';
import { PageMeta } from '../../_components/shell/page-meta';
import { Chip, StatusDot } from '../../_components/ui/primitives';
import { AllClear } from '../../_components/ui/states';

export const dynamic = 'force-dynamic';

/**
 * The phone check — 390px, read-only.
 *
 * Same order as the desktop overview so muscle memory carries: platforms,
 * alerts, MRR, funnel. Nothing here is a link and nothing here is an action,
 * and that is the design's own argument rather than a limitation — there is
 * nothing to do from a phone but know.
 *
 * Rendered inside a device frame on the desktop console because this is a
 * PREVIEW of the narrow view, reached from the sidebar, not a responsive
 * breakpoint. At 390px the frame collapses to the viewport.
 */
export default async function NarrowOverviewPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const flags = parseFixtureFlags(await searchParams, usingFixtures(process.env));

  const [report, feed, list] = await Promise.all([
    getOverview(flags),
    getAlertFeed(flags),
    getStoreList({ filter: {}, sort: 'orders', cursor: 0, limit: 200 }, flags),
  ]);

  const steps = activationFunnel(list.stores);

  return (
    <>
      <PageMeta capturedAt={report.capturedAt} partial={report.partial} />

      <div className="mx-auto w-[390px] max-w-full overflow-hidden rounded-[26px] border border-line bg-ground shadow-card">
        <div className="flex flex-col gap-3 p-3">
          <section className="flex flex-col gap-2">
            {report.platforms.map(({ platform, overview }) => {
              const success = successRateBps(overview.ingestion.processed, overview.ingestion.failed);
              const state = platformState(overview.ingestion, success);
              return (
                <div
                  key={platform}
                  className="flex items-center gap-[7px] rounded-hero border border-line bg-surface px-3 py-[10px]"
                >
                  <StatusDot tone={state.tone} />
                  <span className="text-title font-extrabold capitalize">{platform}</span>
                  <span className="ml-auto text-meta text-muted">{bpsToPercent(success, 1)} · 24h</span>
                  <Chip tone={state.tone}>{state.label}</Chip>
                </div>
              );
            })}
          </section>

          <section className="overflow-hidden rounded-hero border border-line bg-surface">
            <h2 className="border-b border-line px-3 py-[9px] text-title font-extrabold">Alerts</h2>
            {feed.alerts.length === 0 ? (
              <AllClear detail={`${count(report.totals.stores)} stores checked`} />
            ) : (
              <ul>
                {feed.alerts.map((alert) => {
                  const look = alertPresentation(alert);
                  return (
                    <li key={alert.key} className="border-b border-rule px-3 py-[9px] last:border-b-0">
                      <div className="flex items-baseline gap-2">
                        <span className="text-cell-lg font-bold">{look.title}</span>
                        <Chip tone={look.severity === 'ok' ? 'neutral' : look.severity} className="ml-auto">
                          {look.badge}
                        </Chip>
                      </div>
                      <p className="mt-[2px] font-mono text-meta text-muted">
                        {alert.storeId ?? alert.platform}
                      </p>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <section className="rounded-hero bg-accent-surface px-3 py-[11px] text-accent-ink">
            <div className="text-kicker font-bold tracking-caps uppercase text-accent-muted">
              List MRR · SAR ex-VAT
            </div>
            <div className="mt-1 text-hero font-extrabold tracking-figure-tight">
              {minorToRiyals(report.totals.listMrrMinor)}
            </div>
            <div className="mt-2 flex items-baseline gap-4 border-t border-accent-line pt-2 text-meta">
              <span>{count(report.totals.active)} paid</span>
              <span>{count(report.totals.trialing)} trialing</span>
              <span>{count(report.totals.pastDue)} past due</span>
            </div>
          </section>

          <section className="rounded-hero border border-line bg-surface px-3 py-[11px]">
            <h2 className="text-title font-extrabold">Activation</h2>
            <dl className="mt-2 flex flex-col gap-[6px]">
              {steps.map((step) => (
                <div key={step.step} className="flex items-baseline justify-between text-cell-lg">
                  <dt className="text-muted">{step.step}</dt>
                  <dd className="font-bold">
                    {step.count === null ? <span className="text-muted">{NO_VALUE}</span> : count(step.count)}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        </div>
      </div>
    </>
  );
}
