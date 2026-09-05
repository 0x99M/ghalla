import type { PaymentQueue } from '../../../lib/queries/payment-queue';
import { clampBarWidth, count } from '../../../lib/ui/format';
import { cn } from '../../../lib/ui/cn';
import { Bar, Card, CardBody, CardHeader, Chip } from '../ui/primitives';
import { StoreRef } from '../ui/store-ref';

/**
 * A work list, not a metric.
 *
 * Every row is a payment rail an adapter could not map, which means its gateway
 * fee was priced by fallback — a margin shown to a merchant that we cannot
 * stand behind. Ranked by ORDER COUNT because the label on four hundred orders
 * is worth a fee rule and the one on two is not.
 *
 * The handoff puts a completion bar in the header so the queue "reads
 * finishable". There is nothing to measure completion against: the query
 * returns what is currently unmapped and no table records what has been
 * resolved. Rather than draw a progress bar out of nothing, each row carries
 * its share of the affected order volume — which is the number that actually
 * decides what to do first.
 */
export function PaymentMethodQueue({ queue }: { readonly queue: PaymentQueue }) {
  const totalOrders = queue.rows.reduce((sum, row) => sum + row.orders, 0);
  const max = Math.max(1, ...queue.rows.map((row) => row.orders));

  return (
    <Card>
      <CardHeader
        title="Unknown payment method labels"
        meta={`${String(queue.rows.length)} labels · ${count(totalOrders)} orders priced by fallback`}
      />

      {queue.rows.length === 0 ? (
        <CardBody>
          <p className="text-cell-lg text-muted">
            Every payment rail on every order maps to a known instrument. Nothing to decide.
          </p>
        </CardBody>
      ) : (
        <ul>
          {queue.rows.map((row) => (
            <li
              key={`${row.platform}:${row.storeId}:${row.rawMethodLabel}`}
              className="flex items-center gap-3 border-b border-rule px-[14px] py-[10px] last:border-b-0"
            >
              <span className="w-[220px] shrink-0">
                <span className="block font-mono text-cell-lg font-medium">{row.rawMethodLabel}</span>
                <span className="mt-[2px] block text-meta text-muted">
                  mapped to <span className="font-semibold">{row.instrument}</span>
                </span>
              </span>

              <StoreRef
                platform={row.platform}
                platformStoreId={row.storeId.split(':')[1] ?? row.storeId}
                storeId={row.storeId}
                className="w-[150px] shrink-0"
              />

              <span className="min-w-0 flex-1">
                <span className="flex items-baseline justify-between text-meta text-muted">
                  <span>share of unmapped orders</span>
                  <span className="font-semibold text-ink">
                    {count(row.orders)}
                    <span className="ml-2 text-muted">
                      {totalOrders === 0 ? '—' : `${String(Math.round((row.orders * 100) / totalOrders))}%`}
                    </span>
                  </span>
                </span>
                <Bar className="mt-[5px]" height={6} width={clampBarWidth((row.orders / max) * 100)} tone="info" />
              </span>

              <button
                type="button"
                disabled
                title="Writing a fee rule goes through the integration's admin API, which is not built yet"
                className="shrink-0 cursor-not-allowed rounded-pill-lg border border-line px-[11px] py-[6px] text-meta-lg font-semibold text-muted opacity-60"
              >
                Map to a rail
              </button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/**
 * The second queue, drawn at half strength.
 *
 * Same pattern, no data, and it is here rather than hidden because the shape of
 * this screen is "queues an operator works through" — showing one queue makes
 * it look like a page about payment methods.
 */
export function CampaignQueue() {
  return (
    <Card className={cn('opacity-50')}>
      <CardHeader
        title="Unmatched campaigns"
        meta="attribution"
        action={<Chip tone="info">Phase 2</Chip>}
      />
      <CardBody>
        <p className="text-cell-lg text-muted">
          Ad-spend attribution is not built. This queue appears when campaign matching ships — the `ads`
          tier is defined and deliberately unpurchasable until then.
        </p>
      </CardBody>
    </Card>
  );
}
