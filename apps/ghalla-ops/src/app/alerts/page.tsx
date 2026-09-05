import { getPortalDb } from '../../lib/db/portal-db';
import { getRegistry } from '../../lib/platforms';
import { activeAcks } from '../../lib/portal/alert-acks';
import { alertFeed } from '../../lib/queries/alert-feed';

export const dynamic = 'force-dynamic';

export default async function AlertsPage() {
  const now = new Date();
  const feed = await alertFeed(getRegistry(), async () => activeAcks(getPortalDb(), now), now);

  return (
    <main>
      <h1>Alerts</h1>
      {feed.acksUnavailable === null ? null : (
        <p role="alert">
          Acknowledgements could not be read ({feed.acksUnavailable}); every alert below is shown
          unacknowledged.
        </p>
      )}
      <ul>
        {feed.alerts.map((alert) => (
          <li key={alert.key}>
            {alert.kind} · {alert.platform} · {alert.storeId ?? '—'} · {alert.detail}
            {alert.acknowledgedUntil === null ? null : ` · acknowledged until ${alert.acknowledgedUntil}`}
          </li>
        ))}
      </ul>
      <h2>Not computed yet</h2>
      <ul>
        {Object.entries(feed.unavailable).map(([kind, reason]) => (
          <li key={kind}>
            {kind}: {reason}
          </li>
        ))}
      </ul>
      <p>Last updated {feed.capturedAt}</p>
    </main>
  );
}
