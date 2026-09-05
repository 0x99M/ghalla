import { getRegistry } from '../lib/platforms';
import { overview } from '../lib/queries/overview';

export const dynamic = 'force-dynamic';

/**
 * Scaffold. Unstyled on purpose — the design arrives as a later brief, and
 * anything invented here would read as a decision while waiting to be deleted.
 *
 * A Server Component reading `lib/queries` directly, which is the shape the
 * brief asks for: the API routes exist for what the client does afterwards
 * (filtering, polling, actions), not for the first paint.
 */
export default async function OverviewPage() {
  const report = await overview(getRegistry(), new Date());

  return (
    <main>
      <h1>Overview</h1>
      <p>
        {report.totals.stores} stores · {report.totals.active} active · {report.totals.trialing} trialing ·{' '}
        {report.totals.pastDue} past due
      </p>
      <p>
        List MRR {report.totals.listMrrMinor} halalas
        {report.totals.unknownPlanSubscriptions > 0
          ? ` (${report.totals.unknownPlanSubscriptions} subscriptions on a plan code this build does not know, excluded)`
          : null}
      </p>
      <p>
        Queue {report.totals.queueDepth} · stalled {report.totals.stalledJobs} · orders 24h{' '}
        {report.totals.ordersIngested24h}
      </p>
      {report.partial ? (
        <p role="alert">
          Partial: {report.missing.map((m) => `${m.platform} (${m.reason})`).join('; ')}
        </p>
      ) : null}
      <p>Last updated {report.capturedAt}</p>
      <nav>
        <a href="/stores">Stores</a> · <a href="/alerts">Alerts</a> · <a href="/revenue">Revenue</a> ·{' '}
        <a href="/queues/unknown-payment-methods">Unmapped payment methods</a>
      </nav>
      <form method="post" action="/api/auth/logout">
        <button type="submit">Sign out</button>
      </form>
    </main>
  );
}
