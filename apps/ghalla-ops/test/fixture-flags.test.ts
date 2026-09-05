import { describe, expect, it } from 'vitest';
import { NO_FLAGS, parseFixtureFlags } from '../src/lib/fixtures/flags';

describe('parseFixtureFlags', () => {
  it('is inert unless the console is on fixtures', () => {
    // A stray query parameter must never blank a real operator's store list.
    expect(parseFixtureFlags({ zeroStores: '1', railState: 'failed' }, false)).toStrictEqual(NO_FLAGS);
  });

  it('accepts 1 and true, and nothing else', () => {
    expect(parseFixtureFlags({ alertsClear: '1' }, true).alertsClear).toBe(true);
    expect(parseFixtureFlags({ alertsClear: 'true' }, true).alertsClear).toBe(true);
    expect(parseFixtureFlags({ alertsClear: 'yes' }, true).alertsClear).toBe(false);
    expect(parseFixtureFlags({}, true).alertsClear).toBe(false);
  });

  it('falls back to normal for an unrecognised rail state', () => {
    expect(parseFixtureFlags({ railState: 'loading' }, true).railState).toBe('loading');
    expect(parseFixtureFlags({ railState: 'failed' }, true).railState).toBe('failed');
    expect(parseFixtureFlags({ railState: 'exploded' }, true).railState).toBe('normal');
  });

  it('takes the first value of a repeated parameter', () => {
    expect(parseFixtureFlags({ railState: ['failed', 'loading'] }, true).railState).toBe('failed');
  });
});
