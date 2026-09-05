'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { Check } from 'lucide-react';
import { cn } from '../../../lib/ui/cn';

/**
 * The one write this console can make, and it writes to the portal's OWN
 * database.
 *
 * Acknowledging an alert touches `alert_ack`, a portal-owned table — never an
 * integration's. That is why it needs no confirmation dialog and no red panel:
 * nothing about a merchant changes, the alert does not disappear, and the worst
 * outcome is that a problem stops being highlighted for 24 hours.
 *
 * The acknowledgement EXPIRES, at read time, from `acknowledged_at`. A
 * persisting problem resurfaces tomorrow whether or not anything ran overnight,
 * which is why there is no "un-acknowledge" here to build.
 */
export function AckButton({ alertKey, acknowledged }: { readonly alertKey: string; readonly acknowledged: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [failed, setFailed] = useState<string | null>(null);

  if (acknowledged) {
    return (
      <span className="flex shrink-0 items-center gap-1 text-meta text-muted">
        <Check size={12} strokeWidth={2} aria-hidden />
        acked
      </span>
    );
  }

  return (
    <button
      type="button"
      disabled={pending}
      title="Silence this alert for 24 hours. It returns tomorrow if the problem persists."
      onClick={(event) => {
        // The row is a link to the store; acknowledging must not navigate.
        event.preventDefault();
        event.stopPropagation();
        setFailed(null);
        start(async () => {
          const response = await fetch(`/api/alerts/${encodeURIComponent(alertKey)}/ack`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({}),
          });
          if (!response.ok) {
            setFailed(`ack failed (${String(response.status)})`);
            return;
          }
          router.refresh();
        });
      }}
      className={cn(
        'relative z-10 shrink-0 cursor-pointer rounded-chip border border-line bg-surface px-[7px] py-[3px] text-meta font-semibold text-muted transition-colors',
        'hover:border-track hover:text-ink disabled:opacity-50',
        failed !== null && 'border-bad-fill text-bad',
      )}
    >
      {failed ?? (pending ? 'acking…' : 'Ack 24h')}
    </button>
  );
}
