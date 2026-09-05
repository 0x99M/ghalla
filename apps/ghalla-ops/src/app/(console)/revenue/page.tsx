import { getRevenue, getStoreList } from '../../../lib/data';
import { usingFixtures } from '../../../lib/data/source';
import { parseFixtureFlags } from '../../../lib/fixtures/flags';
import { parseRange } from '../../../lib/api/params';
import { PageMeta } from '../../_components/shell/page-meta';
import {
  ChurnTable,
  RevenueGaps,
  RevenueHeadline,
  RevenueMix,
} from '../../_components/revenue/sections';
import { SectionError } from '../../_components/ui/states';

export const dynamic = 'force-dynamic';

export default async function RevenuePage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = await searchParams;
  const flags = parseFixtureFlags(raw, usingFixtures(process.env));
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'string') params.set(key, value);
  }

  const parsed = parseRange(params);
  const now = new Date();
  if (!parsed.ok) {
    return <SectionError title="That range is not valid" error={parsed.issues.join(' · ')} at={now.toISOString()} />;
  }

  const [report, list] = await Promise.all([
    getRevenue(parsed.value),
    getStoreList({ filter: {}, sort: 'installed', cursor: 0, limit: 200 }, flags),
  ]);

  return (
    <>
      <PageMeta capturedAt={report.capturedAt} partial={report.partial} />

      {report.partial ? (
        <SectionError
          title="Some platforms could not be read"
          error={report.missing.map((entry) => `${entry.platform}: ${entry.reason}`).join(' · ')}
          at={report.capturedAt}
        />
      ) : null}

      <RevenueHeadline report={report} />
      <RevenueMix report={report} />
      <ChurnTable stores={list.stores} now={now} />
      <RevenueGaps report={report} />
    </>
  );
}
