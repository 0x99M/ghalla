import { timingSafeEqual } from './access-key';

/**
 * A signed session cookie, using WEB CRYPTO rather than `node:crypto`.
 *
 * Deliberate: this code runs in Next's middleware as well as in route handlers,
 * and middleware may execute on a runtime where `node:crypto` does not exist.
 * One implementation that works in both beats two that can disagree about
 * whether a token is valid — a disagreement whose two failure modes are
 * "locked out" and "let in".
 *
 * The signing key is DERIVED FROM THE ACCESS KEY, which is the property that
 * makes rotation meaningful: changing `OPS_ACCESS_KEY` invalidates every
 * outstanding session at the same moment it stops accepting the old key. A
 * separate session secret would leave every stolen cookie working until it
 * expired on its own.
 */

export const SESSION_COOKIE = 'ghalla_ops_session';

/**
 * Domain separation. Signing `v1.<payload>` rather than the bare payload means
 * a signature minted here can never be mistaken for one over some other
 * message, and the version gives a way to change the format later without
 * accepting both silently.
 */
const SIGNING_PREFIX = 'ghalla-ops/session/v1';

export interface Session {
  /** Random per login. What `actor_session` records, and the closest thing to identity here. */
  readonly sessionId: string;
  /** Epoch milliseconds. Absolute, never extended. */
  readonly expiresAt: number;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

/** Throws on invalid input, which is what `atob` does. */
function decodeBase64Url(value: string): Uint8Array {
  const binary = atob(value.replaceAll('-', '+').replaceAll('_', '/'));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** The caller-facing form, for the signature — where a client really can send rubbish. */
function fromBase64Url(value: string): Uint8Array | null {
  try {
    return decodeBase64Url(value);
  } catch {
    return null;
  }
}

async function signingKey(accessKey: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(accessKey),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
}

async function sign(accessKey: string, payload: string): Promise<Uint8Array> {
  const key = await signingKey(accessKey);
  const message = new TextEncoder().encode(`${SIGNING_PREFIX}.${payload}`);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, message));
}

/** A fresh session id. 128 bits, which is plenty to distinguish two logins. */
export function newSessionId(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(16)));
}

export async function mintSession(accessKey: string, session: Session): Promise<string> {
  const payload = toBase64Url(new TextEncoder().encode(JSON.stringify(session)));
  const signature = await sign(accessKey, payload);
  return `${payload}.${toBase64Url(signature)}`;
}

/**
 * Why a session was refused.
 *
 * Distinguished for the LOG, never for the response — telling a caller that
 * their signature was valid but expired says the key used to be right, and that
 * is a hint worth withholding. Every failure looks the same from outside.
 */
export type SessionRejection = 'malformed' | 'bad_signature' | 'expired';

export type SessionCheck =
  | { readonly ok: true; readonly session: Session }
  | { readonly ok: false; readonly reason: SessionRejection };

export async function verifySession(
  accessKey: string,
  token: string | undefined,
  now: number,
): Promise<SessionCheck> {
  if (token === undefined || token === '') return { ok: false, reason: 'malformed' };

  const separator = token.indexOf('.');
  if (separator <= 0) return { ok: false, reason: 'malformed' };
  const payload = token.slice(0, separator);
  const presented = fromBase64Url(token.slice(separator + 1));
  if (presented === null) return { ok: false, reason: 'malformed' };

  // The signature is checked BEFORE the payload is parsed. Parsing first would
  // run JSON.parse over attacker-controlled bytes and, worse, would let the
  // shape of the failure report whether the payload was well-formed.
  const expected = await sign(accessKey, payload);
  if (!timingSafeEqual(presented, expected)) return { ok: false, reason: 'bad_signature' };

  // Decoding and parsing share one guard, deliberately. A payload that carries
  // a valid signature is by definition one we produced, so it always decodes —
  // a separate check for that would be a branch no input can take, sitting
  // where a reader expects a real one. What CAN still fail is the parse.
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(decodeBase64Url(payload)));
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  const session = parsed as Partial<Session>;
  if (typeof session.sessionId !== 'string' || typeof session.expiresAt !== 'number') {
    return { ok: false, reason: 'malformed' };
  }
  if (session.expiresAt <= now) return { ok: false, reason: 'expired' };

  return { ok: true, session: { sessionId: session.sessionId, expiresAt: session.expiresAt } };
}

export interface CookieAttributes {
  readonly httpOnly: true;
  readonly sameSite: 'lax';
  readonly secure: boolean;
  readonly path: '/';
  readonly maxAge: number;
}

/**
 * `Secure` follows the deployment, not a hard-coded true: a portal served over
 * plain HTTP on a developer's laptop would otherwise set a cookie the browser
 * throws away, and the resulting "login does nothing" is the kind of bug people
 * work around by turning the flag off everywhere.
 *
 * `SameSite=Lax` rather than `Strict` so that following a link to the portal
 * from a chat message lands logged in. There is no cross-site POST worth
 * protecting here that `Lax` does not already cover.
 */
export function cookieAttributes(ttlMs: number, secure: boolean): CookieAttributes {
  return { httpOnly: true, sameSite: 'lax', secure, path: '/', maxAge: Math.floor(ttlMs / 1000) };
}
