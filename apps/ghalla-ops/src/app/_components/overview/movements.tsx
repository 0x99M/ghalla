import type { PlatformStore } from '../../../lib/queries/stores';
import { recentChurns, recentInstalls, storePresentation, tenureMonths } from '../../../lib/ui/presentation';
import { bpsToPercent } from '../../../lib/ui/format';
import { Card, CardHeader, Chip } from '../ui/primitives';
import { StoreRef } from '../ui/store-ref';
import { TimeStamp } from '../ui/stamp';

/**
 * Who arrived and who left, side by side.
 *
 * The churn list carries FINAL COST COVERAGE next to tenure, and that pairing is
 * the point of the panel rather than decoration: a merchant who left after four
 * months with 9% of their revenue priced never saw a number worth staying for.
 * Coverage is the churn predictor this product has, and putting it beside the
 * departure is what makes it visible without a report.
 */

export function RecentInstalls({
  stores,
  now,
  limit = 5,
}: {
  readonly stores: readonly PlatformStore[];
  readonly now: Date;
  readonly limit?: number;
}) {
  const rows = recentInstalls(stores, limit);

  return (
    <Card>
      <CardHeader title="Recent installs" meta={`newest ${String(rows.length)}`} />
      <ul>
        {rows.map((store) => {
          const look = storePresentation(store);
          return (
            <li
              key={store.storeId}
              className="flex items-center gap-3 border-b border-rule px-[14px] py-[9px] last:border-b-0"
            >
              <StoreRef
                platform={store.platform}
                platformStoreId={store.platformStoreId}
                storeId={store.storeId}
                className="flex-1"
              />
              <Chip tone={look.severity === 'ok' ? 'neutral' : look.severity}>{look.label}</Chip>
              <span className="w-[52px] shrink-0 text-right text-meta text-muted">
                <TimeStamp at={store.installedAt} now={now} />
              </span>
            </li>
          );
        })}
        {rows.length === 0 ? (
          <li className="px-[14px] py-[18px] text-cell-lg text-muted">No installs yet.</li>
        ) : null}
      </ul>
    </Card>
  );
}

export function RecentChurns({
  stores,
  now,
  limit = 5,
}: {
  readonly stores: readonly PlatformStore[];
  readonly now: Date;
  readonly limit?: number;
}) {
  const rows = recentChurns(stores, limit);

  return (
    <Card>
      <CardHeader title="Recent churns" meta="tenure · final coverage" />
      <ul>
        {rows.map((store) => {
          const coverage = store.coverage?.coverageBps ?? null;
          return (
            <li
              key={store.storeId}
              className="flex items-center gap-3 border-b border-rule px-[14px] py-[9px] last:border-b-0"
            >
              <StoreRef
                platform={store.platform}
                platformStoreId={store.platformStoreId}
                storeId={store.storeId}
                className="flex-1"
              />
              <span className="w-[56px] shrink-0 text-right text-meta text-muted">
                {String(tenureMonths(store.installedAt, store.uninstalledAt))} mo
              </span>
              <span
                className={`w-[52px] shrink-0 text-right text-meta font-bold ${
                  coverage !== null && coverage < 4_000 ? 'text-bad' : 'text-muted'
                }`}
              >
                cov {bpsToPercent(coverage)}
              </span>
              <span className="w-[46px] shrink-0 text-right text-meta text-muted">
                <TimeStamp at={store.uninstalledAt} now={now} />
              </span>
            </li>
          );
        })}
        {rows.length === 0 ? (
          <li className="px-[14px] py-[18px] text-cell-lg text-muted">Nobody has left.</li>
        ) : null}
      </ul>
    </Card>
  );
}
