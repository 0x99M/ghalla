import { getIngestionReport } from '../../../lib/data';
import { parseRange } from '../../../lib/api/params';
import { PageMeta } from '../../_components/shell/page-meta';
import {
  FailedJobsTable,
  HealthGaps,
  HealthStats,
  PlatformHealth,
} from '../../_components/health/sections';
import { SectionError } from '../../_components/ui/states';

export const dynamic = 'force-dynamic';

/**
 * Queues, failures and the webhook path — the screen opened when something is
 * wrong.
 *
 * The range comes from the same `parseRange` the API route uses, so the topbar
 * control and this page cannot disagree about what `?range=90d` means.
 */
export default async function HealthPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = await searchParams;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'string') params.set(key, value);
  }

  const parsed = parseRange(params);
  const now = new Date();
  if (!parsed.ok) {
    return <SectionError title="That range is not valid" error={parsed.issues.join(' · ')} at={now.toISOString()} />;
  }

  const report = await getIngestionReport(parsed.value);

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

      <HealthStats report={report} />
      <PlatformHealth report={report} now={now} />
      <FailedJobsTable report={report} now={now} />
      <HealthGaps />
    </>
  );
}
