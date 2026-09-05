import Link from 'next/link';
import type { PlatformStore } from '../../../lib/queries/stores';
import { storePresentation } from '../../../lib/ui/presentation';
import { NO_VALUE, bpsToPercent, clampBarWidth, count } from '../../../lib/ui/format';
import { cn } from '../../../lib/ui/cn';
import { Chip, StatusDot } from '../ui/primitives';
import { TimeStamp } from '../ui/stamp';

/**
 * The store table.
 *
 * A problem row is marked THREE ways — a tinted ground, an inset left bar, and
 * a ▲ before the identifier — and that redundancy is the requirement, not
 * belt-and-braces. Around 8% of men have a red-green deficiency, the two row
 * tints here are a warm red and a warm amber a few percent off white, and an
 * operator who cannot separate them still has to be able to scan this table.
 * The health column then says it in words.
 *
 * Not virtualised, deliberately: ~312 rows inside a 640px scroll container
 * renders in a frame, and windowing would add a scroll-position bug class for
 * no measurable gain.
 */

const ROW_TONE: Readonly<Record<string, string>> = {
  bad: 'bg-bad-row shadow-[inset_3px_0_0_var(--color-bad-dot)]',
  warn: 'bg-warn-row shadow-[inset_3px_0_0_var(--color-warn-dot)]',
  ok: 'bg-surface',
};

const STATUS_TONE = {
  active: 'ok',
  trialing: 'neutral',
  past_due: 'bad',
  canceled: 'neutral',
  expired: 'neutral',
} as const;

export function StoreTable({
  stores,
  now,
}: {
  readonly stores: readonly PlatformStore[];
  readonly now: Date;
}) {
  return (
    <div className="max-h-[640px] overflow-auto rounded-card border border-line bg-surface shadow-card">
      <table className="w-full border-collapse text-cell-lg">
        <caption className="sr-only">Every merchant, with subscription, ingestion and coverage state</caption>
        <thead className="sticky top-0 z-10">
          <tr className="bg-subtle text-left text-kicker tracking-caps text-muted uppercase">
            <th scope="col" className="px-[10px] py-[9px] font-bold">Store</th>
            <th scope="col" className="px-[10px] py-[9px] font-bold">Platform</th>
            <th scope="col" className="px-[10px] py-[9px] font-bold">Plan</th>
            <th scope="col" className="px-[10px] py-[9px] font-bold">Status</th>
            <th scope="col" className="px-[10px] py-[9px] font-bold">Installed</th>
            <th scope="col" className="px-[10px] py-[9px] text-right font-bold">Orders</th>
            <th scope="col" className="px-[10px] py-[9px] font-bold">Cap use</th>
            <th scope="col" className="px-[10px] py-[9px] text-right font-bold">Coverage</th>
            <th scope="col" className="px-[10px] py-[9px] text-right font-bold">Last webhook</th>
            <th scope="col" className="px-[10px] py-[9px] font-bold">Health</th>
          </tr>
        </thead>
        <tbody>
          {stores.map((store) => {
            const look = storePresentation(store);
            const status = store.subscription?.status ?? null;
            const coverage = store.coverage?.coverageBps ?? null;
            const silent = store.health.flags.includes('silent');

            return (
              <tr
                key={store.storeId}
                className={cn(
                  'relative border-b border-rule transition-colors last:border-b-0 hover:brightness-[0.985]',
                  ROW_TONE[look.severity],
                )}
              >
                <td className="px-[10px] py-[9px]">
                  <span className="flex items-baseline gap-[6px]">
                    {look.severity === 'ok' ? null : (
                      <span
                        aria-hidden
                        className={cn(
                          'text-[9px] leading-none',
                          look.severity === 'bad' ? 'text-bad' : 'text-warn',
                        )}
                      >
                        ▲
                      </span>
                    )}
                    {/* The link covers the whole row via ::after, so the row is
                        clickable while staying a real anchor — middle-click and
                        open-in-new-tab keep working, which a router.push row
                        would silently break. */}
                    <Link
                      href={`/stores/${store.platform}/${encodeURIComponent(store.storeId)}`}
                      className="font-mono font-medium after:absolute after:inset-0 after:content-[''] hover:underline"
                    >
                      {store.platformStoreId}
                    </Link>
                  </span>
                </td>
                <td className="px-[10px] py-[9px] capitalize">{store.platform}</td>
                <td className="px-[10px] py-[9px]">{store.subscription?.effectivePlanCode ?? NO_VALUE}</td>
                <td className="px-[10px] py-[9px]">
                  {status === null ? (
                    <span className="text-muted">{NO_VALUE}</span>
                  ) : (
                    <Chip tone={STATUS_TONE[status]}>{status.replace('_', ' ')}</Chip>
                  )}
                </td>
                <td className="px-[10px] py-[9px] text-muted">
                  <TimeStamp at={store.installedAt} now={now} zone={store.timezone} />
                </td>
                <td className="px-[10px] py-[9px] text-right font-semibold">{count(store.ordersInPeriod)}</td>
                <td className="px-[10px] py-[9px]">
                  {look.cap.percent === null ? (
                    <span className="text-meta text-muted">unlimited</span>
                  ) : (
                    <span className="flex items-center gap-2">
                      <span aria-hidden className="h-[6px] w-[44px] overflow-hidden rounded-full bg-track">
                        <span
                          className={cn(
                            'block h-full rounded-full',
                            look.cap.overCap ? 'bg-bad-dot' : look.cap.percent > 85 ? 'bg-warn-dot' : 'bg-ink',
                          )}
                          style={{ width: clampBarWidth(look.cap.percent) }}
                        />
                      </span>
                      <span className={cn('text-meta font-semibold', look.cap.overCap && 'text-bad')}>
                        {look.cap.percent}%
                      </span>
                    </span>
                  )}
                </td>
                <td
                  className={cn(
                    'px-[10px] py-[9px] text-right font-semibold',
                    coverage === null ? 'text-muted' : coverage < 4_000 ? 'text-bad' : coverage < 7_000 ? 'text-warn' : '',
                  )}
                >
                  {bpsToPercent(coverage)}
                </td>
                <td className={cn('px-[10px] py-[9px] text-right', silent ? 'text-bad' : 'text-muted')}>
                  <TimeStamp at={store.lastWebhookAt} now={now} />
                </td>
                <td className="px-[10px] py-[9px]">
                  <span className="flex items-center gap-[6px]">
                    <StatusDot tone={look.severity} />
                    <span className={cn(look.severity === 'ok' ? 'text-muted' : 'font-semibold')}>
                      {look.label}
                    </span>
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
