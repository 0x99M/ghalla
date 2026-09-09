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

/**
 * The one directory of files reachable without a session: the identity kit's
 * copies under `public/brand/`, which are the login page's own logo and the
 * favicon. The login page is open, so what it is made of has to be — and these
 * are static copies of a logo, holding no data. `test/ui-brand.test.ts` keeps
 * the directory to exactly the files `lib/ui/brand` declares.
 *
 * With the trailing slash, so `/brand` itself and `/brandish` stay closed.
 */
export const BRAND_FILES_PREFIX = '/brand/';

export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.includes(pathname) || pathname.startsWith(BRAND_FILES_PREFIX);
}

export type GuardOutcome =
  | { readonly kind: 'allow' }
  /** A browser navigation. Send them somewhere they can do something about it. */
  | { readonly kind: 'redirect'; readonly to: string }
  /** An API call. A redirect to an HTML page would be parsed as data and confuse the caller. */
  | { readonly kind: 'unauthorized' };

/**
 * A base that cannot exist, used only to resolve a candidate and see where it
 * lands. `.invalid` is reserved by RFC 2606 and can never be a real host.
 */
const RESOLUTION_BASE = 'https://portal.invalid';

/**
 * Where to send someone back to after they log in.
 *
 * ONLY a same-site absolute path. A login page is the single most useful place
 * in any application to have an open redirect, because the victim has just been
 * asked to prove they trust the site — so this is checked by RESOLVING the
 * candidate with the same URL parser that will later resolve it, and demanding
 * that it stay on the base origin.
 *
 * That is the whole reason it is not a set of string tests. The first version
 * of this function rejected a literal `//` prefix, and an adversarial review
 * found four ways past it, because `new URL` is not a string comparison:
 * WHATWG resolution treats a BACKSLASH as a slash for special schemes, and
 * strips raw TAB, LF and CR before parsing at all. So `/\host`, `/<TAB>/host`,
 * `/<LF>/host` and `/<CR>/host` all passed the check and then resolved to a
 * foreign origin — carrying, in the same 303, the session cookie the operator
 * had just typed the one shared key to obtain.
 *
 * Resolving here means the guard and the consumer cannot disagree: whatever
 * trick the parser has, both sides have it. A blacklist would have to be
 * extended every time the URL specification grows another equivalence.
 */
export function safeNext(value: string | null | undefined): string | null {
  if (value === undefined || value === null || value === '') return null;
  // Still required: an absolute `https://elsewhere` resolves to its OWN origin
  // and would otherwise be judged against the wrong base.
  if (!value.startsWith('/')) return null;

  let resolved: URL;
  try {
    resolved = new URL(value, RESOLUTION_BASE);
  } catch {
    return null;
  }
  if (resolved.origin !== RESOLUTION_BASE) return null;

  // Rebuilt from the parsed result rather than returned as given, so what the
  // caller redirects to is exactly what was checked — no room for a second
  // parse to read it differently. The fragment is dropped: it never reaches a
  // server, and carrying it would only widen what this has to reason about.
  const path = `${resolved.pathname}${resolved.search}`;
  if (path.startsWith(LOGIN_PATH)) return null;
  return path;
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
