import { accessKeyMatches } from '../../../../lib/auth/access-key';
import { getAuthConfig, getLoginLimiter } from '../../../../lib/auth';
import { clientAddress, isSecureRequest, safeNext } from '../../../../lib/auth/guard';
import { checkLogin, recordLoginFailure, recordLoginSuccess } from '../../../../lib/auth/rate-limit';
import {
  SESSION_COOKIE,
  cookieAttributes,
  mintSession,
  newSessionId,
} from '../../../../lib/auth/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * A plain HTML form post, answered with a redirect.
 *
 * No client JavaScript anywhere in the login path: the one screen that must
 * work when everything else is broken should not depend on a bundle loading.
 *
 * Every `Location` here is RELATIVE, and that is load bearing rather than
 * stylistic. Inside a route handler `request.url` is the address the Node
 * server is listening on, not the address the browser asked for — behind
 * Railway's proxy it is `https://localhost:8080/...`. Resolving a redirect
 * against it sends a successfully authenticated operator to localhost, which
 * fails in the browser while every log line says the login worked. A relative
 * Location is resolved by the client against the URL it actually requested, so
 * there is no host to get wrong. RFC 7231 s7.1.2 permits it.
 */

/** 303 with a relative Location. See the note above on why it is never absolute. */
function seeOther(location: string, cookie?: string): Response {
  const response = new Response(null, { status: 303, headers: { Location: location } });
  if (cookie !== undefined) response.headers.append('Set-Cookie', cookie);
  return response;
}
export async function POST(request: Request): Promise<Response> {
  const { accessKey, sessionTtlMs } = getAuthConfig();
  const limiter = getLoginLimiter();
  const now = Date.now();
  const source = clientAddress(request.headers);

  const form = await request.formData();
  const next = safeNext(String(form.get('next') ?? '')) ?? '/';
  const secure = isSecureRequest(request.headers, request.url);

  const allowed = checkLogin(limiter, source, now);
  if (!allowed.allowed) {
    return seeOther(`/login?error=throttled&next=${encodeURIComponent(next)}`);
  }

  const presented = String(form.get('key') ?? '');
  if (!(await accessKeyMatches(presented, accessKey))) {
    recordLoginFailure(limiter, source, now);
    return seeOther(`/login?error=invalid&next=${encodeURIComponent(next)}`);
  }

  recordLoginSuccess(limiter, source);
  const token = await mintSession(accessKey, {
    sessionId: newSessionId(),
    expiresAt: now + sessionTtlMs,
  });
  const attributes = cookieAttributes(sessionTtlMs, secure);

  // `next` has already been through `safeNext`, so it is a same-origin path
  // beginning with `/` and can be used as a relative Location as it stands.
  return seeOther(
    next,
    `${SESSION_COOKIE}=${token}; Path=${attributes.path}; Max-Age=${String(attributes.maxAge)}; HttpOnly; SameSite=Lax${
      attributes.secure ? '; Secure' : ''
    }`,
  );
}
