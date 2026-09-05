'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useTransition } from 'react';
import { Search } from 'lucide-react';
import { SUBSCRIPTION_STATUSES } from '@ghalla/contracts';
import { PLAN_CODES } from '@ghalla/billing';
import { STORE_VIEWS, STORE_VIEW_LABELS } from '../../../lib/ui/presentation';
import type { SavedViewCounts, StoreView } from '../../../lib/ui/presentation';
import { count } from '../../../lib/ui/format';
import { cn } from '../../../lib/ui/cn';

/**
 * Filters, saved views and the attention toggle — all held in the URL.
 *
 * Every control writes a query parameter and the server re-renders. No local
 * filter state at all, which is what makes a filtered table a link somebody can
 * send, and what stops the screen and the URL disagreeing after a back button.
 *
 * The platform and plan lists come from `@ghalla/contracts` and
 * `@ghalla/billing` rather than being typed out. A plan added to `PLANS` shows
 * up here without an edit, which is the same argument the query layer makes for
 * deriving `BILLED_STATUSES` from the canonical predicate.
 */
export function FilterBar({
  platforms,
  counts,
  showing,
  total,
}: {
  readonly platforms: readonly string[];
  readonly counts: SavedViewCounts;
  readonly showing: number;
  readonly total: number;
}) {
  const router = useRouter();
  const params = useSearchParams();
  const [pending, start] = useTransition();

  const set = useCallback(
    (changes: Readonly<Record<string, string | null>>) => {
      const next = new URLSearchParams(params.toString());
      for (const [key, value] of Object.entries(changes)) {
        if (value === null || value === '') next.delete(key);
        else next.set(key, value);
      }
      // Any filter change invalidates the offset: page 3 of the old result set
      // is a different set of stores, and landing there looks like data loss.
      next.delete('cursor');
      start(() => {
        router.replace(`?${next.toString()}`, { scroll: false });
      });
    },
    [params, router],
  );

  const view = params.get('view');
  const attention = params.get('needsAttention') === 'true';

  const selectClass =
    'rounded-pill-lg border border-line bg-surface px-[10px] py-[6px] text-cell-lg font-medium text-ink';

  return (
    <div className={cn('flex flex-col gap-[10px]', pending && 'opacity-70')}>
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2 rounded-pill-lg border border-line bg-surface px-[10px] py-[6px]">
          <Search size={13} strokeWidth={2} aria-hidden className="text-faint" />
          <span className="sr-only">Filter by store id</span>
          <input
            type="search"
            name="q"
            defaultValue={params.get('q') ?? ''}
            placeholder="Store id or platform"
            onChange={(event) => {
              set({ q: event.target.value });
            }}
            className="w-[190px] bg-transparent text-cell-lg outline-none placeholder:text-faint"
          />
        </label>

        <select
          aria-label="Platform"
          className={selectClass}
          value={params.get('platform') ?? ''}
          onChange={(event) => {
            set({ platform: event.target.value });
          }}
        >
          <option value="">All platforms</option>
          {platforms.map((platform) => (
            <option key={platform} value={platform}>
              {platform}
            </option>
          ))}
        </select>

        <select
          aria-label="Plan"
          className={selectClass}
          value={params.get('plan') ?? ''}
          onChange={(event) => {
            set({ plan: event.target.value });
          }}
        >
          <option value="">All plans</option>
          {PLAN_CODES.map((code) => (
            <option key={code} value={code}>
              {code}
            </option>
          ))}
        </select>

        <select
          aria-label="Status"
          className={selectClass}
          value={params.get('status') ?? ''}
          onChange={(event) => {
            set({ status: event.target.value });
          }}
        >
          <option value="">All statuses</option>
          {SUBSCRIPTION_STATUSES.map((status) => (
            <option key={status} value={status}>
              {status.replace('_', ' ')}
            </option>
          ))}
        </select>

        <button
          type="button"
          aria-pressed={attention}
          onClick={() => {
            set({ needsAttention: attention ? null : 'true' });
          }}
          className={cn(
            'cursor-pointer rounded-pill-lg border px-[11px] py-[6px] text-cell-lg font-semibold transition-colors',
            attention
              ? 'border-primary bg-primary-tint text-primary-deep'
              : 'border-line bg-surface text-muted hover:text-ink',
          )}
        >
          Needs attention only
        </button>

        <span className="ml-auto text-meta-lg text-muted">
          Showing {count(showing)} of {count(total)}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-[6px]">
        {STORE_VIEWS.map((name) => {
          const active = view === name;
          return (
            <button
              key={name}
              type="button"
              aria-pressed={active}
              onClick={() => {
                set({ view: active ? null : name });
              }}
              className={cn(
                'cursor-pointer rounded-pill border px-[9px] py-[4px] text-meta-lg font-semibold transition-colors',
                active
                  ? 'border-primary bg-primary-tint text-primary-deep'
                  : 'border-line bg-line text-ink hover:border-track',
              )}
            >
              {STORE_VIEW_LABELS[name as StoreView]}
              <span className="ml-[6px] text-muted">{count(counts[keyFor(name)])}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

const KEYS = {
  trialing: 'trialing',
  over_cap: 'overCap',
  past_due: 'pastDue',
  low_coverage: 'lowCoverage',
  silent: 'silent',
} as const satisfies Record<StoreView, keyof SavedViewCounts>;

function keyFor(view: StoreView): keyof SavedViewCounts {
  return KEYS[view];
}
