import { describe, expect, it } from 'vitest';
import { loginNotice } from '../src/lib/ui/login';

describe('loginNotice', () => {
  it('reads a rejected key as a problem', () => {
    expect(loginNotice('invalid')).toEqual({ tone: 'bad', message: 'That key was not accepted.' });
  });

  it('reads throttling as a warning, not a failure', () => {
    expect(loginNotice('throttled')?.tone).toBe('warn');
  });

  it('never says whether the key was wrong, unknown or expired', () => {
    for (const code of ['invalid', 'throttled']) {
      expect(loginNotice(code)?.message).not.toMatch(/wrong|unknown|expired|forged/i);
    }
  });

  it('shows nothing for a code it does not know', () => {
    expect(loginNotice('expired')).toBeNull();
    expect(loginNotice('')).toBeNull();
    expect(loginNotice(undefined)).toBeNull();
    expect(loginNotice(['invalid'])).toBeNull();
  });

  it('cannot be made to say anything by an inherited property name', () => {
    expect(loginNotice('constructor')).toBeNull();
    expect(loginNotice('__proto__')).toBeNull();
    expect(loginNotice('toString')).toBeNull();
  });
});
