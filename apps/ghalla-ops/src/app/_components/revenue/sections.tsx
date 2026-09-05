import type { RevenueReport } from '../../../lib/queries/revenue';
import type { PlatformStore } from '../../../lib/queries/stores';
import { mergePlanRevenue, recentChurns, tenureMonths } from '../../../lib/ui/presentation';
import { bpsToPercent, clampBarWidth, count, minorToRiyals } from '../../../lib/ui/format';
import { cn } from '../../../lib/ui/cn';
import { Bar, Card, CardBody, CardHeader, Figure, Kicker } from '../ui/primitives';
import { Unavailable } from '../ui/states';
import { StoreRef } from '../ui/store-ref';
import { TimeStamp } from '../ui/stamp';

/**
 * LIST MRR, and the label says so everywhere it appears.
 *
 * This is what these subscriptions would bill at list price, ignoring
 * discounts, proration, tax and whether the money was actually collected. It is
 * not revenue, and a screen that called it revenue would be the number quoted
 * in a board update six months from now.
 */
export function RevenueHeadline({ report }: { readonly report: RevenueReport }) {
  return (
    <div className="grid grid-cols-4 gap-3">
      <Card tone="accent" className="col-span-2 px-[14px] py-3">
        <Kicker className="text-accent-muted">List MRR · SAR ex-VAT</Kicker>
        <Figure size="hero" className="mt-1">
          {minorToRiyals(report.listMrrMinor)}
        </Figure>
        <p className="mt-[6px] text-meta text-accent-muted">
          {minorToRiyals(report.listArrMinor)} annualised · {count(report.billedStores)} billed subscriptions ·
          trials excluded
        </p>
      </Card>

      <Card className="px-[14px] py-3">
        <Kicker>Billed subscriptions</Kicker>
        <Figure size="md" className="mt-1">
          {count(report.billedStores)}
        </Figure>
        <p className="mt-[6px] text-meta text-muted">active and past due — a retry usually succeeds</p>
      </Card>

      <Card className="px-[14px] py-3">
        <Kicker>Unknown plan codes</Kicker>
        <Figure size="md" className={cn('mt-1', report.unknownPlanSubscriptions > 0 && 'text-bad')}>
          {count(report.unknownPlanSubscriptions)}
        </Figure>
        <p className="mt-[6px] text-meta text-muted">
          {report.unknownPlanSubscriptions === 0
            ? 'every subscription maps to a known plan'
            : 'excluded from the total — MRR would otherwise fall for no findable reason'}
        </p>
      </Card>
    </div>
  );
}

export function RevenueMix({ report }: { readonly report: RevenueReport }) {
  const byPlan = mergePlanRevenue(report);
  const planMax = Math.max(1, ...byPlan.map((plan) => plan.listMrrMinor));
  const platformMax = Math.max(1, ...report.byPlatform.map((entry) => entry.mrr.listMrrMinor));

  return (
    <div className="grid grid-cols-2 gap-3">
      <Card>
        <CardHeader title="By plan" meta="list MRR, SAR" />
        <CardBody className="flex flex-col gap-[10px]">
          {byPlan.length === 0 ? (
            <p className="text-cell-lg text-muted">No billed subscriptions.</p>
          ) : (
            byPlan.map((plan) => (
              <div key={plan.planCode}>
                <div className="flex items-baseline justify-between text-cell-lg">
                  <span className="font-semibold">{plan.planCode}</span>
                  <span className="text-muted">
                    {count(plan.stores)} stores ·{' '}
                    <span className="font-semibold text-ink">{minorToRiyals(plan.listMrrMinor)}</span>
                  </span>
                </div>
                <Bar
                  className="mt-[5px]"
                  width={clampBarWidth((plan.listMrrMinor / planMax) * 100)}
                  tone="info"
                />
              </div>
            ))
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="By platform" meta="list MRR, SAR" />
        <CardBody className="flex flex-col gap-[10px]">
          {report.byPlatform.map((entry) => (
            <div key={entry.platform}>
              <div className="flex items-baseline justify-between text-cell-lg">
                <span className="font-semibold capitalize">{entry.platform}</span>
                <span className="text-muted">
                  {count(entry.mrr.billedStores)} stores ·{' '}
                  <span className="font-semibold text-ink">{minorToRiyals(entry.mrr.listMrrMinor)}</span>
                </span>
              </div>
              <Bar
                className="mt-[5px]"
                width={clampBarWidth((entry.mrr.listMrrMinor / platformMax) * 100)}
                tone="neutral"
              />
            </div>
          ))}
        </CardBody>
      </Card>
    </div>
  );
}

/**
 * Who left, how long they stayed, and what their coverage was when they went.
 *
 * The last column is the point. Coverage is the churn predictor this product
 * has — a merchant whose margins were computed from a tenth of their revenue
 * never saw a number worth paying for — and putting it beside tenure is what
 * turns a list of departures into a reason.
 */
export function ChurnTable({
  stores,
  now,
}: {
  readonly stores: readonly PlatformStore[];
  readonly now: Date;
}) {
  const rows = recentChurns(stores, 12);

  return (
    <Card>
      <CardHeader title="Churn" meta="tenure and final cost coverage" />
      {rows.length === 0 ? (
        <CardBody>
          <p className="text-cell-lg text-muted">Nobody has uninstalled.</p>
        </CardBody>
      ) : (
        <table className="w-full border-collapse text-cell-lg">
          <thead>
            <tr className="bg-subtle text-left text-kicker tracking-caps text-muted uppercase">
              <th scope="col" className="px-[14px] py-[9px] font-bold">Store</th>
              <th scope="col" className="px-[14px] py-[9px] font-bold">Plan</th>
              <th scope="col" className="px-[14px] py-[9px] text-right font-bold">Tenure</th>
              <th scope="col" className="px-[14px] py-[9px] text-right font-bold">Final coverage</th>
              <th scope="col" className="px-[14px] py-[9px] text-right font-bold">Left</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((store) => {
              const coverage = store.coverage?.coverageBps ?? null;
              return (
                <tr key={store.storeId} className="border-b border-rule last:border-b-0">
                  <td className="px-[14px] py-[9px]">
                    <StoreRef
                      platform={store.platform}
                      platformStoreId={store.platformStoreId}
                      storeId={store.storeId}
                    />
                  </td>
                  <td className="px-[14px] py-[9px]">{store.subscription?.planCode ?? '—'}</td>
                  <td className="px-[14px] py-[9px] text-right">
                    {count(tenureMonths(store.installedAt, store.uninstalledAt))} mo
                  </td>
                  <td
                    className={cn(
                      'px-[14px] py-[9px] text-right font-semibold',
                      coverage !== null && coverage < 4_000 && 'text-bad',
                    )}
                  >
                    {bpsToPercent(coverage)}
                  </td>
                  <td className="px-[14px] py-[9px] text-right text-muted">
                    <TimeStamp at={store.uninstalledAt} now={now} suffix="ago" />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </Card>
  );
}

/** The three time series this screen is designed around, and why none exist yet. */
export function RevenueGaps({ report }: { readonly report: RevenueReport }) {
  return (
    <div className="grid grid-cols-3 gap-3">
      <Unavailable what="MRR over time" reason={report.seriesUnavailable} />
      <Unavailable
        what="Trial → paid conversion"
        reason="needs the state of each trial at the moment it ended; integration databases hold only the present"
      />
      <Unavailable
        what="Cohort retention"
        reason="needs a monthly snapshot per cohort; it lands with the snapshot job that fills platform_snapshot"
      />
    </div>
  );
}
