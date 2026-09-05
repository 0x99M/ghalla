import { getRegistry } from '../../lib/platforms';
import { storeList } from '../../lib/queries/store-list';

export const dynamic = 'force-dynamic';

export default async function StoresPage() {
  const result = await storeList(
    getRegistry(),
    { filter: {}, sort: 'orders', cursor: 0, limit: 50 },
    new Date(),
  );

  return (
    <main>
      <h1>Stores</h1>
      {result.partial ? <p role="alert">Partial: {result.missing.map((m) => m.platform).join(', ')}</p> : null}
      <table>
        <thead>
          <tr>
            <th>Store</th>
            <th>Plan</th>
            <th>Status</th>
            <th>Orders in period</th>
            <th>Coverage bps</th>
            <th>Flags</th>
          </tr>
        </thead>
        <tbody>
          {result.stores.map((store) => (
            <tr key={`${store.platform}:${store.storeId}`}>
              <td>
                <a href={`/stores/${store.platform}/${encodeURIComponent(store.storeId)}`}>{store.storeId}</a>
              </td>
              <td>{store.subscription?.effectivePlanCode ?? '—'}</td>
              <td>{store.subscription?.status ?? '—'}</td>
              <td>{store.ordersInPeriod}</td>
              <td>{store.coverage?.coverageBps ?? '—'}</td>
              <td>{store.health.flags.join(', ') || 'healthy'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p>
        {result.total} stores · last updated {result.capturedAt}
      </p>
    </main>
  );
}
