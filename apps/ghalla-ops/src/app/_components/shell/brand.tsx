import { BRAND_ASSETS, MARK, WORDMARK } from '../../../lib/ui/brand';
import { cn } from '../../../lib/ui/cn';

/**
 * The mark and the wordmark, exactly as the rail shows them.
 *
 * The mark is the kit's own file, served as an image rather than redrawn as
 * markup: a logo drawn twice is a logo that drifts, and the test on
 * `lib/ui/brand` holds the served file equal to the kit's. The wordmark is
 * live text in the kit's face — Poppins SemiBold, sentence case, pulled in by
 * the kit's own tracking — because the lockup SVG carries live `<text>` that an
 * `<img>` cannot load a web font for. "OPS CONSOLE" is not part of the
 * wordmark; it is this product's label in the console's kicker style, and the
 * kit's rule against capitals is about the wordmark alone.
 *
 * Shared with the login page rather than copied there, so the one screen an
 * operator sees BEFORE the console cannot drift from the console itself.
 * Presentational, and deliberately not a client component: the login page has
 * no client bundle and must not acquire one for a logo.
 */
export function Brand({ className }: { readonly className?: string }) {
  return (
    <div className={cn('flex items-center', className)} style={{ gap: MARK.clearSpace }}>
      <img src={BRAND_ASSETS.mark.href} alt="" width={MARK.size} height={MARK.size} className="shrink-0" />
      <div>
        <div className="font-brand text-wordmark font-semibold tracking-wordmark">{WORDMARK}</div>
        <div className="mt-[3px] text-kicker font-bold tracking-brand text-muted">OPS CONSOLE</div>
      </div>
    </div>
  );
}
