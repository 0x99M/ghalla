import Link from 'next/link';
import { ChevronRight } from 'lucide-react';
import type { AlertFeed } from '../../../lib/queries/alert-feed';
import type { Alert } from '../../../lib/queries/alerts';
import { alertPresentation } from '../../../lib/ui/presentation';
import { cn } from '../../../lib/ui/cn';
import { Card, CardHeader, Chip } from '../ui/primitives';
import { AllClear, Unavailable } from '../ui/states';
import { TimeStamp } from '../ui/stamp';
import { AckButton } from './ack-button';

/**
 * The most important element on the console.
 *
 * Ordered by `sortAlerts` — unacknowledged first — rather than re-sorted here.
 * The feed is read top-down during an incident, and a second ordering rule in
 * the component would be a place for the two to disagree.
 *
 * Every row is a link to the thing it is about, because the next action after
 * reading an alert is always to look at the store.
 */

const BAR: Readonly<Record<string, string>> = {
  bad: 'before:bg-bad-dot',
  warn: 'before:bg-warn-dot',
  ok: 'before:bg-faint',
};

const TILE: Readonly<Record<string, string>> = {
  bad: 'bg-bad-fill text-bad',
  warn: 'bg-warn-fill text-warn',
  ok: 'bg-subtle text-muted',
};

function AlertRow({ alert, now }: { readonly alert: Alert; readonly now: Date }) {
  const look = alertPresentation(alert);
  const href = alert.storeId === null ? '/health' : `/stores/${alert.platform}/${encodeURIComponent(alert.storeId)}`;

  return (
    <Link
      href={href}
      className={cn(
        'relative flex items-center gap-3 border-b border-rule px-[14px] py-[11px] transition-colors last:border-b-0 hover:bg-subtle',
        'before:absolute before:inset-y-0 before:left-0 before:w-[3px] before:content-[""]',
        BAR[look.severity],
      )}
    >
      <span
        aria-hidden
        className={cn(
          'flex size-[24px] shrink-0 items-center justify-center rounded-chip-lg text-cell font-extrabold',
          TILE[look.severity],
        )}
      >
        {look.glyph}
      </span>

      <span className="min-w-0 flex-1">
        <span className="block text-title font-bold">{look.title}</span>
        <span className="mt-[1px] block truncate text-meta-lg text-muted">{alert.detail}</span>
      </span>

      <span className="shrink-0 text-right">
        <span className="block font-mono text-meta">{alert.storeId ?? alert.platform}</span>
        <span className="mt-[1px] block text-meta text-muted">
          {alert.acknowledgedUntil === null ? (
            <span className="text-muted">unacknowledged</span>
          ) : (
            <>
              acked until <TimeStamp at={alert.acknowledgedUntil} now={now} />
            </>
          )}
        </span>
      </span>

      <Chip tone={look.severity === 'ok' ? 'neutral' : look.severity}>{look.badge}</Chip>
      <AckButton alertKey={alert.key} acknowledged={alert.acknowledgedUntil !== null} />
      <ChevronRight size={14} strokeWidth={2} aria-hidden className="shrink-0 text-faint" />
    </Link>
  );
}

export function AlertList({
  feed,
  now,
  storeCount,
}: {
  readonly feed: AlertFeed;
  readonly now: Date;
  readonly storeCount: number;
}) {
  const unacknowledged = feed.alerts.filter((alert) => alert.acknowledgedUntil === null).length;

  return (
    <Card>
      <CardHeader
        title="Alerts"
        meta={
          feed.alerts.length === 0
            ? 'nothing raised'
            : `${String(unacknowledged)} unacknowledged of ${String(feed.alerts.length)}`
        }
      />

      {feed.acksUnavailable === null ? null : (
        <p role="alert" className="border-b border-rule bg-warn-row px-[14px] py-2 text-meta-lg text-warn">
          Acknowledgements could not be read ({feed.acksUnavailable}). Every alert below is shown
          unacknowledged, so something you silenced earlier may have reappeared.
        </p>
      )}

      {feed.alerts.length === 0 ? (
        <AllClear detail={`${String(storeCount)} stores checked · no silent stores, stuck backfills, failing jobs or past-due payments`} />
      ) : (
        <div>
          {feed.alerts.map((alert) => (
            <AlertRow key={alert.key} alert={alert} now={now} />
          ))}
        </div>
      )}

      {Object.keys(feed.unavailable).length === 0 ? null : (
        <div className="flex flex-col gap-2 border-t border-line p-[14px]">
          {Object.entries(feed.unavailable).map(([kind, reason]) => (
            <Unavailable key={kind} what={kind.replace(/_/gu, ' ')} reason={reason} />
          ))}
        </div>
      )}
    </Card>
  );
}
