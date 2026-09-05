'use client';

import { Suspense, useCallback, useEffect, useState, useTransition } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { RefreshCw } from 'lucide-react';
import { screenMeta } from '../../../lib/ui/nav';
import { absoluteTime, relativeTime } from '../../../lib/ui/format';
import { cn } from '../../../lib/ui/cn';
import { RangeControl } from './range-control';
import { useScreenState } from './page-meta';

/**
 * How old the figures on screen are, kept honest.
 *
 * The stamp re-computes every 30 seconds. That is NOT auto-refresh — no data is
 * fetched and nothing on the screen changes but this string. It exists because
 * the alternative is worse: a console that renders "updated 2m ago" and then
 * sits untouched for an hour is telling the operator something false, and it is
 * telling them the one thing this console promises to get right.
 *
 * `null` until the page reports, so there is no server/client mismatch and no
 * moment where a previous screen's freshness is claimed for this one.
 */
function useAge(capturedAt: string | null): string | null {
  const [now, setNow] = useState<Date | null>(null);

  useEffect(() => {
    setNow(new Date());
    const timer = setInterval(() => {
      setNow(new Date());
    }, 30_000);
    return () => {
      clearInterval(timer);
    };
  }, [capturedAt]);

  if (capturedAt === null || now === null) return null;
  return relativeTime(capturedAt, now);
}

export function TopBar() {
  const pathname = usePathname();
  const router = useRouter();
  const { capturedAt, title, partial } = useScreenState();
  const [refreshing, startRefresh] = useTransition();
  const meta = screenMeta(pathname);
  const age = useAge(capturedAt);

  /**
   * Clears the 60-second aggregate cache, then re-renders the server
   * components. Both halves are needed: `router.refresh()` alone would re-run
   * the page and be handed the same cached numbers back, which is a refresh
   * button that does nothing — the most corrosive kind of control on a console
   * somebody is trusting during an incident.
   */
  const refresh = useCallback(() => {
    startRefresh(async () => {
      await fetch('/api/refresh', { method: 'POST' });
      router.refresh();
    });
  }, [router]);

  return (
    <header className="flex items-center gap-[14px] border-b border-line bg-surface px-5 py-[14px]">
      <div className="min-w-0">
        <h1 className="text-screen font-extrabold tracking-figure">{title ?? meta.title}</h1>
        <p className="mt-[3px] text-meta-lg text-muted">{meta.subtitle}</p>
      </div>

      <div className="ml-auto flex items-center gap-[10px]">
        {partial ? (
          <span
            role="status"
            className="rounded-chip bg-warn-fill px-[6px] py-[2px] text-chip font-extrabold tracking-chip text-warn"
          >
            PARTIAL
          </span>
        ) : null}

        <Suspense fallback={<div className="h-[30px] w-[168px] rounded-pill-lg bg-line" />}>
          <RangeControl />
        </Suspense>

        <div className="flex items-center gap-2 rounded-pill-lg border border-line py-[6px] pr-[10px] pl-[11px]">
          <span className="text-meta text-muted">Updated</span>
          <span
            className="text-meta-lg font-bold"
            title={capturedAt === null ? 'No report on screen yet' : absoluteTime(capturedAt)}
          >
            {age === null ? '—' : `${age} ago`}
          </span>
          <button
            type="button"
            onClick={refresh}
            disabled={refreshing}
            title="Manual refresh — nothing on this console auto-refreshes"
            aria-label="Refresh"
            className="flex cursor-pointer rounded-chip-lg p-[3px] transition-colors hover:bg-line disabled:cursor-default disabled:opacity-50"
          >
            <RefreshCw
              size={14}
              strokeWidth={2}
              aria-hidden
              className={cn(refreshing && 'motion-safe:animate-spin')}
            />
          </button>
        </div>
      </div>
    </header>
  );
}
