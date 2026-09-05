import { getAlertFeed, getOverview, getStoreList } from '../../lib/data';
import { parseFixtureFlags } from '../../lib/fixtures/flags';
import { usingFixtures } from '../../lib/data/source';
import { RAIL_FAILURE } from '../../lib/fixtures/rail';
import { PageMeta } from '../_components/shell/page-meta';
import { HealthStrip } from '../_components/overview/health-strip';
import { AlertList } from '../_components/overview/alert-list';
import { ActivationFunnel, MrrCard } from '../_components/overview/rail';
import { RecentChurns, RecentInstalls } from '../_components/overview/movements';
import { SectionError, SectionSkeleton } from '../_components/ui/states';
import { Card, CardHeader } from '../_components/ui/primitives';
import { NoStores } from '../_components/ui/states';

export const dynamic = 'force-dynamic';

/**
 * The morning check.
 *
 * Every section reads independently: the alert feed does not wait for the store
 * list, and a platform that could not be read degrades its own card while the
 * rest stays live. That is why the sections are separate awaits rather than one
 * report — and why `Promise.all` here is safe in a way it never is across
 * platforms, since these are three reads of the SAME registry, each of which
 * has already settled its platforms independently.
 */
export default async function OverviewPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const flags = parseFixtureFlags(await searchParams, usingFixtures(process.env));
  const now = new Date();

  const [report, feed, list] = await Promise.all([
    getOverview(flags),
    getAlertFeed(flags),
    getStoreList({ filter: {}, sort: 'orders', cursor: 0, limit: 200 }, flags),
  ]);

  return (
    <>
      <PageMeta capturedAt={report.capturedAt} partial={report.partial} />

      <HealthStrip report={report} now={now} />

      {report.partial ? (
        <SectionError
          title="Some platforms could not be read"
          error={report.missing.map((entry) => `${entry.platform}: ${entry.reason}`).join(' · ')}
          at={report.capturedAt}
        />
      ) : null}

      <div className="grid grid-cols-[minmax(0,1fr)_360px] gap-3">
        <div className="flex flex-col gap-3">
          {report.totals.stores === 0 ? (
            <Card>
              <CardHeader title="Stores" />
              <NoStores />
            </Card>
          ) : (
            <AlertList feed={feed} now={now} storeCount={report.totals.stores} />
          )}

          <div className="grid grid-cols-2 gap-3">
            <RecentInstalls stores={list.stores} now={now} />
            <RecentChurns stores={list.stores} now={now} />
          </div>
        </div>

        <div className="flex flex-col gap-3">
          <MrrCard report={report} />
          {/* The one section the prototype flags can put into each of its three
              states, so a reviewer can see loading and failure beside live
              sections rather than instead of them. */}
          {flags.railState === 'loading' ? (
            <Card>
              <CardHeader title="Activation" meta="all stores" />
              <SectionSkeleton rows={5} />
            </Card>
          ) : flags.railState === 'failed' ? (
            <SectionError title="Activation unavailable" error={RAIL_FAILURE} at={report.capturedAt} />
          ) : (
            <ActivationFunnel stores={list.stores} />
          )}
        </div>
      </div>
    </>
  );
}
