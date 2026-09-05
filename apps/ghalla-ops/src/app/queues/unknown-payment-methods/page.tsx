import { getRegistry } from '../../../lib/platforms';
import { unknownPaymentMethodQueue } from '../../../lib/queries/payment-queue';

export const dynamic = 'force-dynamic';

export default async function UnknownPaymentMethodsPage() {
  const queue = await unknownPaymentMethodQueue(getRegistry());

  return (
    <main>
      <h1>Unmapped payment methods</h1>
      <p>Each row is a rail priced by fallback, so its gateway fee is a guess.</p>
      <ul>
        {queue.rows.map((row) => (
          <li key={`${row.platform}:${row.storeId}:${row.rawMethodLabel}`}>
            {row.rawMethodLabel} ({row.instrument}) · {row.storeId} · {row.orders} orders
          </li>
        ))}
      </ul>
      <p>Last updated {queue.capturedAt}</p>
    </main>
  );
}
