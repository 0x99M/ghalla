'use client';

import { useTransition } from 'react';
import { RefreshCw } from 'lucide-react';

/**
 * Retry ONE section, without reloading the console.
 *
 * Clears the aggregate cache and re-renders the server components — the same
 * two steps the topbar's refresh takes, for the same reason: re-rendering alone
 * would be handed the cached failure back and the button would appear to do
 * nothing.
 *
 * There is deliberately no "show cached" beside it. The handoff offers one, and
 * it would need a stale copy kept alongside the live value; this cache holds a
 * single entry per key with a TTL, so the only thing "show cached" could
 * display is the failure that is already on screen.
 */
export function RetrySection() {
  const [pending, start] = useTransition();

  return (
    <button
      type="button"
      disabled={pending}
      onClick={() => {
        start(async () => {
          await fetch('/api/refresh', { method: 'POST' });
          window.location.reload();
        });
      }}
      className="flex cursor-pointer items-center gap-[6px] rounded-pill-lg border border-bad-fill bg-surface px-[11px] py-[6px] text-meta-lg font-semibold text-bad transition-colors hover:border-bad-dot disabled:opacity-50"
    >
      <RefreshCw size={12} strokeWidth={2} aria-hidden className={pending ? 'motion-safe:animate-spin' : ''} />
      {pending ? 'Retrying…' : 'Retry section'}
    </button>
  );
}
