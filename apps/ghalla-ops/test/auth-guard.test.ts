import { describe, expect, it } from 'vitest';
import {
  LOGIN_PATH,
  clientAddress,
  guard,
  isPublicPath,
  isSecureRequest,
  loginRedirect,
  safeNext,
} from '../src/lib/auth/guard';

describe('guard', () => {
  it('lets an authenticated request through', () => {
    expect(guard('/stores', '', true)).toEqual({ kind: 'allow' });
  });

  it('sends an anonymous page request to the login screen, remembering where it was going', () => {
    expect(guard('/stores', '?status=past_due', false)).toEqual({
      kind: 'redirect',
      to: '/login?next=%2Fstores%3Fstatus%3Dpast_due',
    });
  });

  it('answers an anonymous API request with 401 rather than a redirect', () => {
    // A redirect to an HTML login page arrives at a JSON caller as a 200 full
    // of markup — the shape of bug diagnosed as "the API returned garbage" an
    // hour after somebody's session quietly expired.
    expect(guard('/api/overview', '', false)).toEqual({ kind: 'unauthorized' });
  });

  it('leaves exactly three paths open', () => {
    expect(isPublicPath('/login')).toBe(true);
    expect(isPublicPath('/api/auth/login')).toBe(true);
    expect(isPublicPath('/api/live')).toBe(true);
    expect(isPublicPath('/api/overview')).toBe(false);
    expect(isPublicPath('/')).toBe(false);
  });

  it('and the brand files, which the open login page is made of', () => {
    expect(isPublicPath('/brand/mark-ink.svg')).toBe(true);
    expect(guard('/brand/favicon-32.png', '', false)).toEqual({ kind: 'allow' });
  });

  it('protects a route nobody has written yet, because the default is closed', () => {
    expect(guard('/some/page/added/next/month', '', false).kind).toBe('redirect');
    expect(guard('/api/route/added/next/month', '', false).kind).toBe('unauthorized');
  });

  it('does not treat a path that merely starts with a public one as public', () => {
    expect(isPublicPath('/login-secrets')).toBe(false);
    expect(isPublicPath('/api/live/detail')).toBe(false);
    // The brand rule is a prefix, and the prefix carries its slash.
    expect(isPublicPath('/brand')).toBe(false);
    expect(isPublicPath('/brandish/anything')).toBe(false);
  });
});

describe('safeNext', () => {
  it('accepts a same-site absolute path', () => {
    expect(safeNext('/stores?status=active')).toBe('/stores?status=active');
  });

  it('REFUSES AN OFF-SITE REDIRECT', () => {
    // A login page is the single most useful place in any application to have
    // an open redirect: the victim has just been asked to prove they trust it.
    expect(safeNext('https://elsewhere.example/steal')).toBeNull();
    expect(safeNext('//elsewhere.example/steal')).toBeNull();
  });

  it('refuses every shape that a STRING TEST for "//" lets through', () => {
    // The first version of this guard tested for a literal `//` prefix. All
    // four of these passed it and then resolved to a foreign origin, because
    // `new URL` treats a backslash as a slash for special schemes and strips
    // raw TAB, LF and CR before parsing. The 303 that would have carried them
    // is the one that also sets the session cookie.
    for (const target of ['/\\evil.example/ops', '/\t/evil.example', '/\n/evil.example', '/\r/evil.example']) {
      expect(safeNext(target)).toBeNull();
    }
  });

  it('agrees with the parser that will actually resolve it', () => {
    // The guard resolves rather than pattern-matches, so whatever equivalence
    // the URL specification grows next, both sides have it.
    for (const target of ['/\\evil.example', '/\t/evil.example', '//evil.example', 'https://evil.example']) {
      const accepted = safeNext(target);
      expect(accepted).toBeNull();
      // And the thing the guard refused really would have escaped.
      expect(new URL(target, 'https://ops.example').origin).not.toBe('https://ops.example');
    }
  });

  it('keeps a normal same-site target, path and query intact', () => {
    expect(safeNext('/stores?status=past_due&sort=coverage')).toBe('/stores?status=past_due&sort=coverage');
    expect(safeNext('/')).toBe('/');
  });

  it('drops a fragment, which never reaches a server anyway', () => {
    expect(safeNext('/stores#section')).toBe('/stores');
  });

  it('refuses to bounce back to the login page', () => {
    expect(safeNext('/login')).toBeNull();
    expect(safeNext('/login?next=%2F')).toBeNull();
  });

  it('treats absent and empty the same', () => {
    expect(safeNext(null)).toBeNull();
    expect(safeNext(undefined)).toBeNull();
    expect(safeNext('')).toBeNull();
  });
});

describe('loginRedirect', () => {
  it('falls back to the bare login path when the target is not safe', () => {
    expect(loginRedirect('//evil.example', '')).toBe(LOGIN_PATH);
  });
});

describe('clientAddress', () => {
  it('takes the first entry of x-forwarded-for', () => {
    expect(clientAddress(new Headers({ 'x-forwarded-for': '1.2.3.4, 10.0.0.1' }))).toBe('1.2.3.4');
  });

  it('falls back to x-real-ip, then to a constant', () => {
    expect(clientAddress(new Headers({ 'x-real-ip': '9.9.9.9' }))).toBe('9.9.9.9');
    expect(clientAddress(new Headers())).toBe('unknown');
  });

  it('ignores an empty forwarded header', () => {
    expect(clientAddress(new Headers({ 'x-forwarded-for': '  ', 'x-real-ip': '9.9.9.9' }))).toBe('9.9.9.9');
  });
});

describe('isSecureRequest', () => {
  it('believes the forwarded protocol over the internal URL', () => {
    // Behind a terminating proxy the internal URL is plain http even when the
    // browser used https, and a cookie left un-Secure there would go in the
    // clear on any downgrade.
    expect(isSecureRequest(new Headers({ 'x-forwarded-proto': 'https' }), 'http://internal/login')).toBe(true);
    expect(isSecureRequest(new Headers({ 'x-forwarded-proto': 'http, https' }), 'https://x/')).toBe(false);
  });

  it('falls back to the URL when nothing was forwarded', () => {
    expect(isSecureRequest(new Headers(), 'https://portal.example/login')).toBe(true);
    expect(isSecureRequest(new Headers(), 'http://localhost:3000/login')).toBe(false);
  });
});
