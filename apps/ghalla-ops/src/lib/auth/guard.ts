/**
 * What may be reached without a session, and what happens when there is none.
 *
 * Pure, so the answer to "is this path protected" is a table test rather than a
 * thing you find out by deploying. The middleware is a three-line adapter over
 * it.
 */

export const LOGIN_PATH = '/login';

/**
 * The only unauthenticated surface. Everything else — every page, every API
 * route — is behind the key.
 *
 * `/api/live` is public because Railway's health check calls it and an
 * authenticated health check fails every deploy. It answers with a status word
 * and a timestamp and nothing else; the version that names platforms and
 * describes their connection problems is behind the session, in the overview.
 */
export const PUBLIC_PATHS: readonly string[] = [LOGIN_PATH, '/api/auth/login', '/api/live'];

export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.includes(pathname);
}

export type GuardOutcome =
  | { readonly kind: 'allow' }
  /** A browser navigation. Send them somewhere they can do something about it. */
  | { readonly kind: 'redirect'; readonly to: string }
  /** An API call. A redirect to an HTML page would be parsed as data and confuse the caller. */
  | { readonly kind: 'unauthorized' };

/**
 * Where to send someone back to after they log in.
 *
 * ONLY a same-site absolute path. `next=https://elsewhere.example` would make
 * the login page an open redirect — and a login page is the single most useful
 * place in any application to have one, because the victim has just been asked
 * to prove they trust it. A protocol-relative `//host` is refused for the same
 * reason: browsers treat it as absolute.
 */
export function safeNext(value: string | null | undefined): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (!value.startsWith('/') || value.startsWith('//')) return null;
  if (value.startsWith(LOGIN_PATH)) return null;
  return value;
}

export function loginRedirect(pathname: string, search = ''): string {
  const next = safeNext(`${pathname}${search}`);
  return next === null ? LOGIN_PATH : `${LOGIN_PATH}?next=${encodeURIComponent(next)}`;
}

export function guard(pathname: string, search: string, authenticated: boolean): GuardOutcome {
  if (isPublicPath(pathname) || authenticated) return { kind: 'allow' };
  if (pathname.startsWith('/api/')) return { kind: 'unauthorized' };
  return { kind: 'redirect', to: loginRedirect(pathname, search) };
}

/**
 * The caller's address, for the per-source half of the login limiter.
 *
 * ADVISORY, and treated as such. `x-forwarded-for` is set by Railway's edge here
 * and could be spoofed by a client talking to the service directly, so a
 * determined attacker can make every attempt look like a new source. That is
 * exactly why the limiter has a second tier that does not key on this at all.
 */
export function clientAddress(headers: Headers): string {
  const forwarded = headers.get('x-forwarded-for');
  const first = forwarded?.split(',')[0]?.trim();
  if (first !== undefined && first !== '') return first;
  return headers.get('x-real-ip') ?? 'unknown';
}

/**
 * Whether the response should mark its cookie `Secure`.
 *
 * Read from the forwarded protocol rather than the request URL, because behind
 * a terminating proxy the internal URL is plain http even when the browser used
 * https — and a cookie left un-`Secure` there would be sent in the clear on any
 * downgrade.
 */
export function isSecureRequest(headers: Headers, url: string): boolean {
  const forwarded = headers.get('x-forwarded-proto')?.split(',')[0]?.trim();
  if (forwarded !== undefined && forwarded !== '') return forwarded === 'https';
  return url.startsWith('https:');
}
