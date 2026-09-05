import type { Env } from '../platforms/config';

/**
 * One shared secret, and everything behind it.
 *
 * This is the instruction the portal was built to, and it is worth being
 * explicit about what it does and does not give us, because the consequences
 * show up in the schema.
 *
 * It gives real protection: nothing is reachable without the key, there is no
 * registration flow to attack, no password reset to phish, and no user store to
 * leak. For one operator that is a smaller attack surface than OAuth, not a
 * larger one.
 *
 * It gives NO identity. "Who ran the backfill" is not a question this portal
 * can answer — which is why the audit columns are called `actor_session` and
 * hold a random per-login id rather than being called `actor` and implying a
 * person. Rotation and revocation are the same act: change the variable and
 * redeploy, and every session dies with it, because the session signing key is
 * derived from this one.
 *
 * The honest signal that this has stopped being the right design is a second
 * person needing the key.
 */

/**
 * 32 characters, refused below it, and this is the load-bearing control.
 *
 * Rate limiting slows an attacker down; length is what makes the attempt
 * pointless. A short memorable key behind a rate limiter is still a short
 * memorable key, so the portal will not start with one — better a failed deploy
 * than a portal holding every merchant's business data behind `admin123`.
 */
export const MIN_ACCESS_KEY_LENGTH = 32;

export class AuthConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthConfigError';
  }
}

export interface AuthConfig {
  readonly accessKey: string;
  readonly sessionTtlMs: number;
}

/**
 * Eight hours.
 *
 * Long enough to sit through an incident without being logged out halfway, and
 * short enough that a laptop left open in a café is not a standing grant. There
 * is no sliding renewal: a session that quietly extends itself forever is not a
 * short session.
 */
export const DEFAULT_SESSION_TTL_MS = 8 * 60 * 60 * 1000;

export function loadAuthConfig(env: Env): AuthConfig {
  const accessKey = env['OPS_ACCESS_KEY'];
  if (accessKey === undefined || accessKey.trim() === '') {
    throw new AuthConfigError('OPS_ACCESS_KEY is not set; the portal will not serve without it.');
  }
  if (accessKey.length < MIN_ACCESS_KEY_LENGTH) {
    throw new AuthConfigError(
      `OPS_ACCESS_KEY must be at least ${String(MIN_ACCESS_KEY_LENGTH)} characters. ` +
        'Generate one with `openssl rand -base64 32`.',
    );
  }
  return { accessKey, sessionTtlMs: DEFAULT_SESSION_TTL_MS };
}

/**
 * Constant-time equality over two byte arrays.
 *
 * `a === b` on strings returns as soon as it finds a difference, and the time
 * that takes is a measurement of how many leading characters were right. That
 * is a real attack on a comparison run once per request, and it costs one loop
 * to remove.
 *
 * The lengths are compared into the same accumulator rather than short-circuited,
 * so a wrong-length guess is not distinguishable from a wrong-value one either.
 */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  let difference = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }
  return difference === 0;
}

/**
 * Compares the presented key against the configured one, in constant time.
 *
 * Both sides are hashed first. That is not for secrecy — the configured key is
 * already in memory — it is so the comparison always runs over 32 bytes
 * whatever the caller sent, which removes the length of the guess as a signal.
 */
export async function accessKeyMatches(presented: string, configured: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(presented)),
    crypto.subtle.digest('SHA-256', encoder.encode(configured)),
  ]);
  return timingSafeEqual(new Uint8Array(a), new Uint8Array(b));
}
