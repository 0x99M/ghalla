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
 */
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
    return Response.redirect(
      new URL(`/login?error=throttled&next=${encodeURIComponent(next)}`, request.url),
      303,
    );
  }

  const presented = String(form.get('key') ?? '');
  if (!(await accessKeyMatches(presented, accessKey))) {
    recordLoginFailure(limiter, source, now);
    return Response.redirect(
      new URL(`/login?error=invalid&next=${encodeURIComponent(next)}`, request.url),
      303,
    );
  }

  recordLoginSuccess(limiter, source);
  const token = await mintSession(accessKey, {
    sessionId: newSessionId(),
    expiresAt: now + sessionTtlMs,
  });
  const attributes = cookieAttributes(sessionTtlMs, secure);

  const response = new Response(null, { status: 303, headers: { Location: new URL(next, request.url).toString() } });
  response.headers.append(
    'Set-Cookie',
    `${SESSION_COOKIE}=${token}; Path=${attributes.path}; Max-Age=${String(attributes.maxAge)}; HttpOnly; SameSite=Lax${
      attributes.secure ? '; Secure' : ''
    }`,
  );
  return response;
}
