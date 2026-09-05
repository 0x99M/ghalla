import { safeNext } from '../../lib/auth/guard';

export const dynamic = 'force-dynamic';

const MESSAGES: Record<string, string> = {
  invalid: 'That key was not accepted.',
  throttled: 'Too many failed attempts. Wait a minute and try again.',
};

/**
 * One field, no client JavaScript.
 *
 * A plain form posting to a route that answers with a redirect. The screen that
 * has to work when everything else is broken should not depend on a bundle
 * loading, and there is nothing here that needs one.
 *
 * The error text never distinguishes a wrong key from an unknown one, because
 * there is nothing to distinguish — there is one key. It also never says
 * whether a session expired or was forged: both are just "not accepted".
 */
export default async function LoginPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const rawNext = params['next'];
  const next = safeNext(typeof rawNext === 'string' ? rawNext : null) ?? '/';
  const rawError = params['error'];
  const message = typeof rawError === 'string' ? MESSAGES[rawError] : undefined;

  return (
    <main>
      <h1>Ghalla Ops</h1>
      <form method="post" action="/api/auth/login">
        <input type="hidden" name="next" value={next} />
        <label htmlFor="key">Access key</label>
        <input id="key" name="key" type="password" autoComplete="off" autoFocus required />
        <button type="submit">Enter</button>
      </form>
      {message === undefined ? null : <p role="alert">{message}</p>}
    </main>
  );
}
