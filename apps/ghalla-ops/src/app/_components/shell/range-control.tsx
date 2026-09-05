'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useTransition } from 'react';
import { RANGES } from '../../../lib/queries/window';
import type { Range } from '../../../lib/queries/window';
import { cn } from '../../../lib/ui/cn';

/**
 * 24h / 7d / 30d / 90d, held in the URL.
 *
 * The URL rather than component state, for two reasons that both matter on an
 * operator console: a screen an operator wants to show somebody else is a link
 * that arrives showing the same window, and the server components that read
 * `range` get it from the request without any client round trip.
 *
 * Other query parameters are preserved. Changing the range on a filtered store
 * list must not silently clear the filter that made the list worth looking at.
 */
export function RangeControl() {
  const router = useRouter();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();

  const raw = params.get('range');
  const active: Range = (RANGES as readonly string[]).includes(raw ?? '') ? (raw as Range) : '7d';

  const pick = (range: Range): void => {
    const next = new URLSearchParams(params.toString());
    next.set('range', range);
    startTransition(() => {
      router.replace(`?${next.toString()}`, { scroll: false });
    });
  };

  return (
    <div
      role="group"
      aria-label="Time range"
      data-pending={pending ? '' : undefined}
      className="flex rounded-pill-lg border border-line bg-line p-[2px] data-pending:opacity-70"
    >
      {RANGES.map((range) => {
        const selected = range === active;
        return (
          <button
            key={range}
            type="button"
            aria-pressed={selected}
            onClick={() => {
              pick(range);
            }}
            className={cn(
              'cursor-pointer rounded-[8px] px-[11px] py-[5px] text-meta-lg font-bold transition-colors',
              selected ? 'bg-primary text-white' : 'text-muted hover:text-ink',
            )}
          >
            {range}
          </button>
        );
      })}
    </div>
  );
}
