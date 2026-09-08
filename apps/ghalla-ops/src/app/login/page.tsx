import { TriangleAlert } from 'lucide-react';
import { safeNext } from '../../lib/auth/guard';
import { cn } from '../../lib/ui/cn';
import { loginNotice } from '../../lib/ui/login';
import { Brand } from '../_components/shell/brand';
import { Card, Kicker } from '../_components/ui/primitives';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Sign in · Ghalla Ops',
};

/**
 * One field, no client JavaScript.
 *
 * A plain form posting to a route that answers with a redirect. The screen that
 * has to work when everything else is broken should not depend on a bundle
 * loading, and there is nothing here that needs one — the primitives it shares
 * with the console are server components, and the brand mark is the rail's own
 * so the two cannot drift apart.
 *
 * Which notice a `?error=` code produces, and in which tone, is decided in
 * `lib/ui/login` where a test holds it still. The text never distinguishes a
 * wrong key from an unknown one, because there is nothing to distinguish —
 * there is one key. It also never says whether a session expired or was
 * forged: both are just "not accepted".
 *
 * The notice sits ABOVE the field and is wired to it with `aria-describedby`,
 * so it is read before the operator types again rather than after.
 */
export default async function LoginPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const rawNext = params['next'];
  const next = safeNext(typeof rawNext === 'string' ? rawNext : null) ?? '/';
  const notice = loginNotice(params['error']);

  return (
    <main className="grid min-h-dvh place-items-center bg-shell px-4 py-10">
      <div className="flex w-full max-w-[360px] flex-col gap-5 motion-safe:animate-fadein">
        <Brand className="px-1" />

        <Card>
          <form method="post" action="/api/auth/login" className="flex flex-col gap-4 p-5">
            <div className="flex flex-col gap-[6px]">
              <Kicker>Operator access</Kicker>
              <h1 className="text-section-lg font-extrabold tracking-[-0.01em]">Enter the access key</h1>
              <p className="text-cell text-muted">
                One key, held by the deployment. Nothing on this console answers without it.
              </p>
            </div>

            {notice === null ? null : (
              <p
                id="login-notice"
                role="alert"
                className={cn(
                  'flex items-start gap-2 rounded-chip-lg border px-[10px] py-2 text-cell font-medium',
                  notice.tone === 'bad' ? 'border-bad-fill bg-bad-row text-bad' : 'border-warn-fill bg-warn-row text-warn',
                )}
              >
                <TriangleAlert size={14} strokeWidth={2} aria-hidden className="mt-[1px] shrink-0" />
                <span>{notice.message}</span>
              </p>
            )}

            <input type="hidden" name="next" value={next} />

            <div className="flex flex-col gap-[6px]">
              <label htmlFor="key" className="text-meta font-bold tracking-caps uppercase text-muted">
                Access key
              </label>
              <input
                id="key"
                name="key"
                type="password"
                autoComplete="off"
                autoFocus
                required
                spellCheck={false}
                aria-describedby={notice === null ? undefined : 'login-notice'}
                aria-invalid={notice?.tone === 'bad' ? true : undefined}
                className="h-[38px] w-full rounded-chip-lg border border-line bg-subtle px-3 font-mono text-cell-lg text-ink placeholder:text-faint focus:bg-surface"
                placeholder="••••••••••••••••"
              />
            </div>

            <button
              type="submit"
              className="h-[38px] rounded-pill-lg bg-primary text-title font-bold text-accent-ink transition-colors hover:bg-primary-hover"
            >
              Enter
            </button>
          </form>
        </Card>

        <p className="px-1 text-meta text-muted">
          Sessions are bound to the key. Rotating it signs every session out at once.
        </p>
      </div>
    </main>
  );
}
