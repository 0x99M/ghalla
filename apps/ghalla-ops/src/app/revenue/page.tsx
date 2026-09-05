import { getRegistry } from '../../lib/platforms';
import { revenue } from '../../lib/queries/revenue';

export const dynamic = 'force-dynamic';

export default async function RevenuePage() {
  const report = await revenue(getRegistry(), '30d', new Date());

  return (
    <main>
      <h1>Revenue</h1>
      {report.partial ? (
        <p role="alert">
          Partial: {report.missing.map((m) => `${m.platform} (${m.reason})`).join('; ')}
        </p>
      ) : null}
      <p>
        List MRR {report.listMrrMinor} halalas · list ARR {report.listArrMinor} · {report.billedStores}{' '}
        billed stores
      </p>
      {report.unpricedSubscriptions > 0 ? (
        <p role="alert">{report.unpricedSubscriptions} subscriptions excluded: their plan has no list price.</p>
      ) : null}
      <p>{report.seriesUnavailable}</p>
      <p>Last updated {report.capturedAt}</p>
    </main>
  );
}
