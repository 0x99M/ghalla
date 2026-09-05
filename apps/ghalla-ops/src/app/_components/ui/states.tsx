import { CircleCheck, TriangleAlert } from 'lucide-react';
import { cn } from '../../../lib/ui/cn';
import { Card } from './primitives';
import { RetrySection } from './retry';

/**
 * What a section shows when it is not showing data.
 *
 * Four distinct answers, kept distinct on purpose. "Loading", "there is nothing
 * here", "this could not be read" and "this is not built yet" are four
 * different facts, and a console that renders any of them as an empty box tells
 * the operator the same thing for all four — which is how a broken integration
 * gets read as a quiet week.
 */

/** State 4: one section still loading while its neighbours are live. */
export function SectionSkeleton({ rows = 3, className }: { readonly rows?: number; readonly className?: string }) {
  return (
    <div className={cn('flex flex-col gap-2 p-[14px]', className)} aria-busy role="status">
      <span className="sr-only">Loading</span>
      {Array.from({ length: rows }, (_, index) => (
        <div
          key={index}
          aria-hidden
          className="h-[34px] rounded-chip-lg bg-[linear-gradient(90deg,var(--color-subtle)_0%,var(--color-line)_50%,var(--color-subtle)_100%)] bg-[length:320px_100%] motion-safe:animate-shimmer"
          style={{ opacity: 1 - index * 0.18 }}
        />
      ))}
    </div>
  );
}

/**
 * State 5: this section failed, the rest of the console did not.
 *
 * Carries the driver's own error string rather than a friendly summary. There
 * is one reader, they are technical, and `connect ECONNREFUSED 10.4.2.19:5432`
 * tells them which box to look at while "Something went wrong" tells them
 * nothing. "Show cached" is offered separately because a two-hour-old number is
 * often enough to answer the question, as long as its age is on the label.
 */
export function SectionError({
  title,
  error,
  at,
  retry = true,
}: {
  readonly title: string;
  readonly error: string;
  readonly at: string;
  readonly retry?: boolean;
}) {
  return (
    <Card tone="danger">
      <div className="flex flex-col gap-[10px] p-[14px]">
        <div className="flex items-center gap-2">
          <TriangleAlert size={15} strokeWidth={2} aria-hidden className="text-bad" />
          <h2 className="text-title font-extrabold text-bad">{title}</h2>
        </div>
        <p className="rounded-chip-lg border border-bad-fill bg-surface px-[10px] py-2 font-mono text-meta break-words text-bad">
          {error}
        </p>
        <p className="text-meta text-muted">Last attempt {at}</p>
        {retry ? (
          <div className="flex items-center gap-2">
            <RetrySection />
          </div>
        ) : null}
      </div>
    </Card>
  );
}

/**
 * State 1: the good state, and the one an operator sees most mornings.
 *
 * Must read as confident rather than broken — a blank panel where the alert
 * list normally is looks like a failed fetch, and an operator who is not sure
 * goes looking. The green tile and the counts are what say "checked, nothing
 * found" instead of "nothing loaded".
 */
export function AllClear({ detail }: { readonly detail: string }) {
  return (
    <div className="flex items-center gap-3 px-[14px] py-[22px]">
      <span className="flex size-[34px] shrink-0 items-center justify-center rounded-pill bg-ok-fill">
        <CircleCheck size={18} strokeWidth={2} aria-hidden className="text-ok" />
      </span>
      <div>
        <p className="text-title font-bold">All clear across Salla and Zid</p>
        <p className="mt-[2px] text-meta-lg text-muted">{detail}</p>
      </div>
    </div>
  );
}

/** State 2: no stores yet. Says what will happen, not how to use the console. */
export function NoStores() {
  return (
    <div className="flex flex-col items-start gap-[6px] px-[14px] py-[26px]">
      <p className="text-title font-bold">No stores yet</p>
      <p className="max-w-[52ch] text-meta-lg text-muted">
        Installs appear here within seconds of the first OAuth callback. Nothing to do until then.
      </p>
    </div>
  );
}

/**
 * Not built yet, with the reason the query layer gave.
 *
 * Distinct from an error and from an empty result, and the query layer already
 * makes that distinction — `RevenueReport.seriesUnavailable` and
 * `UNAVAILABLE_ALERTS` both carry a sentence explaining what is missing. This
 * renders that sentence instead of drawing an empty chart, because an empty
 * chart says "no revenue" and the truth is "no history yet".
 */
export function Unavailable({ what, reason }: { readonly what: string; readonly reason: string }) {
  return (
    <div className="flex flex-col gap-[6px] rounded-card-lg border border-dashed border-rule bg-subtle-alt px-[14px] py-[18px]">
      <p className="text-cell-lg font-bold text-muted">{what}</p>
      <p className="max-w-[64ch] text-meta-lg text-faint">{reason}</p>
    </div>
  );
}
