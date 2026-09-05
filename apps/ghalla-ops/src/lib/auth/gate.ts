import { guard } from './guard';
import { verifySession } from './session';
import { SESSION_HEADER } from './session-header';
import type { GuardOutcome } from './guard';

/**
 * The middleware's decision, as a pure function.
 *
 * Lifted out of `middleware.ts` because the interesting half is security
 * critical and a Next entry point is an awkward place to test: `forwarded`
 * below is what stops a client choosing what the audit log records, and that
 * deserves assertions rather than a code review.
 */

export interface GateResult {
  readonly outcome: GuardOutcome;
  /** The verified session id, or `null`. Never taken from the request. */
  readonly sessionId: string | null;
}

export async function gate(
  accessKey: string,
  pathname: string,
  search: string,
  token: string | undefined,
  now: number,
): Promise<GateResult> {
  const check = await verifySession(accessKey, token, now);
  return {
    outcome: guard(pathname, search, check.ok),
    sessionId: check.ok ? check.session.sessionId : null,
  };
}

/**
 * The headers passed downstream, with the session stamped on.
 *
 * THE HEADER IS DELETED FIRST, unconditionally, including on public paths and
 * for unauthenticated requests. Without that a client sends
 * `x-ops-session: whoever` and picks what the audit log attributes an action
 * to — which is the entire value of the audit log. Deleting first means the
 * only way this header arrives with a value is that this function put it there.
 */
export function forwardedHeaders(original: Headers, sessionId: string | null): Headers {
  const forwarded = new Headers(original);
  forwarded.delete(SESSION_HEADER);
  if (sessionId !== null) forwarded.set(SESSION_HEADER, sessionId);
  return forwarded;
}
