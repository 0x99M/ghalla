import { describe, expect, it } from 'vitest';
import { forwardedHeaders, gate } from '../src/lib/auth/gate';
import { SESSION_HEADER, sessionFromHeaders } from '../src/lib/auth/session-header';
import { mintSession } from '../src/lib/auth/session';

const KEY = 'k'.repeat(32);
const NOW = 1_800_000_000_000;

describe('gate', () => {
  it('allows a valid session and reports its id', async () => {
    const token = await mintSession(KEY, { sessionId: 'session-1', expiresAt: NOW + 60_000 });
    expect(await gate(KEY, '/stores', '', token, NOW)).toEqual({
      outcome: { kind: 'allow' },
      sessionId: 'session-1',
    });
  });

  it('reports no session id when the cookie is absent, expired or forged', async () => {
    const expired = await mintSession(KEY, { sessionId: 'session-1', expiresAt: NOW });
    for (const token of [undefined, 'nonsense.nonsense', expired]) {
      const result = await gate(KEY, '/stores', '', token, NOW);
      expect(result.sessionId).toBeNull();
      expect(result.outcome.kind).toBe('redirect');
    }
  });

  it('lets the login page and the liveness probe through unauthenticated', async () => {
    for (const path of ['/login', '/api/auth/login', '/api/live']) {
      expect((await gate(KEY, path, '', undefined, NOW)).outcome).toEqual({ kind: 'allow' });
    }
  });

  it('answers an unauthenticated API call with 401 rather than a redirect', async () => {
    expect((await gate(KEY, '/api/overview', '', undefined, NOW)).outcome).toEqual({
      kind: 'unauthorized',
    });
  });
});

describe('forwardedHeaders', () => {
  it('stamps the verified session id', () => {
    const headers = forwardedHeaders(new Headers(), 'session-1');
    expect(headers.get(SESSION_HEADER)).toBe('session-1');
    expect(sessionFromHeaders(headers)).toBe('session-1');
  });

  it('STRIPS A CLIENT-SUPPLIED SESSION HEADER, which is the whole point', () => {
    // Without this a client sends `x-ops-session: whoever` and chooses what the
    // audit log attributes an action to — which is the entire value of the
    // audit log.
    const spoofed = new Headers({ [SESSION_HEADER]: 'i-am-the-operator' });
    expect(forwardedHeaders(spoofed, null).get(SESSION_HEADER)).toBeNull();
    expect(forwardedHeaders(spoofed, 'real-session').get(SESSION_HEADER)).toBe('real-session');
  });

  it('keeps every other header', () => {
    const original = new Headers({ 'x-forwarded-for': '1.2.3.4', [SESSION_HEADER]: 'spoof' });
    const forwarded = forwardedHeaders(original, null);
    expect(forwarded.get('x-forwarded-for')).toBe('1.2.3.4');
  });

  it('does not mutate the headers it was given', () => {
    const original = new Headers({ [SESSION_HEADER]: 'spoof' });
    forwardedHeaders(original, 'real');
    expect(original.get(SESSION_HEADER)).toBe('spoof');
  });
});

describe('sessionFromHeaders', () => {
  it('is null for an absent or empty header', () => {
    expect(sessionFromHeaders(new Headers())).toBeNull();
    expect(sessionFromHeaders(new Headers({ [SESSION_HEADER]: '' }))).toBeNull();
  });
});
