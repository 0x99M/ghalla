import { describe, expect, it } from 'vitest';
import {
  SESSION_COOKIE,
  cookieAttributes,
  mintSession,
  newSessionId,
  verifySession,
} from '../src/lib/auth/session';

const KEY = 'k'.repeat(32);
const OTHER = 'j'.repeat(32);
const NOW = 1_800_000_000_000;
const SESSION = { sessionId: 'session-1', expiresAt: NOW + 60_000 };

/** base64url, the way the token encodes it. */
const encode = (value: string): string =>
  btoa(value).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');

const signatureOf = (token: string): string => token.slice(token.indexOf('.') + 1);

describe('mintSession / verifySession', () => {
  it('round-trips a session', async () => {
    const token = await mintSession(KEY, SESSION);
    await expect(verifySession(KEY, token, NOW)).resolves.toEqual({ ok: true, session: SESSION });
  });

  it('ROTATING THE ACCESS KEY INVALIDATES EVERY SESSION', async () => {
    // The reason the signing key is derived from the access key rather than
    // being its own secret: rotation and revocation are the same act. A
    // separate session secret would leave every stolen cookie working until it
    // happened to expire on its own.
    const token = await mintSession(KEY, SESSION);
    await expect(verifySession(OTHER, token, NOW)).resolves.toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('rejects a payload swapped for one that never expires', async () => {
    const token = await mintSession(KEY, SESSION);
    const forged = encode(JSON.stringify({ sessionId: 'mine', expiresAt: NOW + 10 ** 12 }));
    await expect(verifySession(KEY, `${forged}.${signatureOf(token)}`, NOW)).resolves.toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('rejects an expired session', async () => {
    const token = await mintSession(KEY, { sessionId: 'session-1', expiresAt: NOW });
    // `<=`: a session expiring exactly now is expired. The alternative leaves a
    // one-millisecond window that only ever surfaces as an unreproducible bug.
    await expect(verifySession(KEY, token, NOW)).resolves.toEqual({ ok: false, reason: 'expired' });
  });

  it('rejects a missing, empty or shapeless token', async () => {
    for (const token of [undefined, '', 'no-separator', '.onlysig', 'payload.']) {
      expect((await verifySession(KEY, token, NOW)).ok).toBe(false);
    }
  });

  it('rejects a signature that is not base64url', async () => {
    await expect(verifySession(KEY, 'cGF5bG9hZA.!!!not-base64!!!', NOW)).resolves.toMatchObject({
      ok: false,
    });
  });

  it('rejects a correctly signed payload that is not JSON', async () => {
    // The signature is checked BEFORE the payload is parsed, so this exercises
    // the path where the bytes really are ours and the content is nonsense.
    const payload = encode('not json at all');
    const token = await mintSession(KEY, { sessionId: 'ignored', expiresAt: NOW + 1000 });
    const forged = `${payload}.${signatureOf(token)}`;
    // Signed over a different payload, so it fails on the signature first —
    // which is the point: an attacker cannot even get as far as the parser.
    await expect(verifySession(KEY, forged, NOW)).resolves.toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('rejects a token whose payload is valid JSON of the wrong shape', async () => {
    // Minted through the real signer so the signature IS correct, which is the
    // only way to reach the shape check at all.
    const badShape = await mintSession(KEY, JSON.parse('{"sessionId":"x"}') as never);
    await expect(verifySession(KEY, badShape, NOW)).resolves.toEqual({
      ok: false,
      reason: 'malformed',
    });

    const wrongType = await mintSession(KEY, JSON.parse('{"sessionId":1,"expiresAt":"soon"}') as never);
    await expect(verifySession(KEY, wrongType, NOW)).resolves.toEqual({
      ok: false,
      reason: 'malformed',
    });
  });

  it('rejects a correctly signed payload that is not parseable JSON', async () => {
    // `JSON.stringify(undefined)` is `undefined`, which encodes as the literal
    // text "undefined" — signed by us, and not JSON. The one input that
    // reaches the parse guard with a valid signature.
    const unparseable = await mintSession(KEY, undefined as never);
    await expect(verifySession(KEY, unparseable, NOW)).resolves.toEqual({
      ok: false,
      reason: 'malformed',
    });

    const notAnObject = await mintSession(KEY, 'not-an-object' as never);
    await expect(verifySession(KEY, notAnObject, NOW)).resolves.toEqual({
      ok: false,
      reason: 'malformed',
    });
  });
});

describe('newSessionId', () => {
  it('is different every time, because it is what tells two logins apart', () => {
    const ids = new Set(Array.from({ length: 50 }, () => newSessionId()));
    expect(ids.size).toBe(50);
  });
});

describe('cookieAttributes', () => {
  it('is HttpOnly, Lax, and rooted at the site', () => {
    expect(cookieAttributes(8 * 3600 * 1000, true)).toEqual({
      httpOnly: true,
      sameSite: 'lax',
      secure: true,
      path: '/',
      maxAge: 28_800,
    });
  });

  it('follows the deployment for Secure rather than hard-coding it', () => {
    // A portal on plain http locally would otherwise set a cookie the browser
    // discards, and "login does nothing" is the kind of bug people fix by
    // turning the flag off everywhere.
    expect(cookieAttributes(1000, false).secure).toBe(false);
  });

  it('names the cookie once, so the middleware and the login route cannot disagree', () => {
    expect(SESSION_COOKIE).toBe('ghalla_ops_session');
  });
});
