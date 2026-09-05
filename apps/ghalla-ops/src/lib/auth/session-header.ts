/**
 * How a verified session reaches a route handler.
 *
 * The middleware has already checked the cookie, so a route re-verifying it
 * would do the cryptography twice and — worse — could disagree with the check
 * that let the request in. Instead the middleware stamps the session id onto
 * the forwarded request and routes read it here.
 *
 * THE HEADER IS DELETED BEFORE IT IS SET, on every request, including the
 * public ones. Without that, a client could simply send
 * `x-ops-session: whoever` and choose what the audit log records — which is the
 * whole value of the audit log. Deleting first means the only way this header
 * has a value is that the middleware put it there.
 */
export const SESSION_HEADER = 'x-ops-session';

export function sessionFromHeaders(headers: Headers): string | null {
  const value = headers.get(SESSION_HEADER);
  return value === null || value === '' ? null : value;
}
