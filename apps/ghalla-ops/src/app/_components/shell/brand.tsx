import { cn } from '../../../lib/ui/cn';

/**
 * The mark and the two-line wordmark, exactly as the rail shows them.
 *
 * Shared with the login page rather than copied there, so the one screen an
 * operator sees BEFORE the console cannot drift from the console itself.
 * Presentational, and deliberately not a client component: the login page has
 * no client bundle and must not acquire one for a logo.
 */
export function Brand({ className }: { readonly className?: string }) {
  return (
    <div className={cn('flex items-center gap-[9px]', className)}>
      <div className="flex size-[30px] items-center justify-center rounded-pill bg-ink text-title font-extrabold text-rail">
        G
      </div>
      <div>
        <div className="text-section-lg font-extrabold tracking-[-0.01em]">GHALLA</div>
        <div className="mt-[3px] text-kicker font-bold tracking-brand text-muted">OPS CONSOLE</div>
      </div>
    </div>
  );
}
