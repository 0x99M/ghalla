import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getAuthConfig } from './lib/auth';
import { forwardedHeaders, gate } from './lib/auth/gate';
import { SESSION_COOKIE } from './lib/auth/session';

/**
 * Every route, including `/api`, behind one session check.
 *
 * A middleware rather than a per-route guard on purpose: a per-route check
 * protects the routes somebody remembered to decorate, and the failure mode of
 * forgetting one is an unprotected page nobody notices. Here the default is
 * closed and the exceptions are a list of three paths in `guard.ts`.
 *
 * The decisions live in `lib/auth/gate.ts` and are tested there; this file is
 * the adapter between them and Next. If `OPS_ACCESS_KEY` is missing or too
 * short, `getAuthConfig` throws and every request fails — the correct
 * direction, and a failed deploy is a far better outcome than an open one.
 */
export async function middleware(request: NextRequest): Promise<NextResponse> {
  const { accessKey } = getAuthConfig();
  const { outcome, sessionId } = await gate(
    accessKey,
    request.nextUrl.pathname,
    request.nextUrl.search,
    request.cookies.get(SESSION_COOKIE)?.value,
    Date.now(),
  );

  if (outcome.kind === 'allow') {
    return NextResponse.next({ request: { headers: forwardedHeaders(request.headers, sessionId) } });
  }
  if (outcome.kind === 'unauthorized') {
    // A redirect to an HTML login page would arrive at a JSON caller as a 200
    // full of markup — the shape of bug diagnosed as "the API returned
    // garbage" an hour after somebody's session quietly expired.
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  return NextResponse.redirect(new URL(outcome.to, request.url));
}

export const config = {
  /**
   * Everything except Next's own static output. Written as an exclusion so a
   * new route is protected by default — an inclusion list would leave every
   * page added later open until somebody remembered to add it.
   */
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
