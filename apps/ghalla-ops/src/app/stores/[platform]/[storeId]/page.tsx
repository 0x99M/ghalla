import { notFound } from 'next/navigation';
import { getRegistry } from '../../../../lib/platforms';
import { storeDetail } from '../../../../lib/queries/store-detail';

export const dynamic = 'force-dynamic';

export default async function StoreDetailPage({
  params,
}: {
  readonly params: Promise<{ platform: string; storeId: string }>;
}) {
  const { platform, storeId } = await params;
  // Already decoded by Next; see the route handler beside this page.
  const result = await storeDetail(getRegistry(), platform, storeId, new Date());

  if (result.kind === 'unavailable') {
    // A platform we could not read is NOT a store that does not exist, and
    // showing a 404 for it would send an operator looking for the wrong thing.
    return (
      <main>
        <h1>{storeId}</h1>
        <p role="alert">{platform} could not be read: {result.reason}</p>
      </main>
    );
  }
  if (result.kind !== 'found') notFound();

  const { store, recentFailures } = result.detail;
  return (
    <main>
      <h1>{store.storeId}</h1>
      <p>
        {store.subscription?.effectivePlanCode ?? '—'} · {store.subscription?.status ?? '—'} ·{' '}
        {store.ordersInPeriod} orders in period
      </p>
      <p>
        Coverage {store.coverage?.coverageBps ?? '—'} bps over{' '}
        {store.coverage?.revenueExVatMinor ?? 0} halalas
      </p>
      <p>Health: {store.health.flags.join(', ') || 'healthy'}</p>
      <p>Last webhook {store.lastWebhookAt ?? 'never'}</p>
      <h2>Recent failures</h2>
      <ul>
        {recentFailures.map((failure) => (
          <li key={failure.id}>
            {failure.receivedAt} · {failure.eventType} · {failure.attempts} attempts · {failure.lastError}
          </li>
        ))}
      </ul>
    </main>
  );
}
