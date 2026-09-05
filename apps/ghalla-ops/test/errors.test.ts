import { describe, expect, it } from 'vitest';
import { describeError } from '../src/lib/errors';

/**
 * Written after a real one. The portal's own database was refusing connections
 * and the health endpoint said `Failed query: select 1` — Drizzle's wrapper,
 * with the `ECONNREFUSED` that actually mattered one property away on `cause`.
 */
describe('describeError', () => {
  it('keeps both the wrapper and the cause, because each answers half the question', () => {
    const cause = new Error('connect ECONNREFUSED 127.0.0.1:5599');
    expect(describeError(new Error('Failed query: select 1', { cause }))).toBe(
      'Failed query: select 1: connect ECONNREFUSED 127.0.0.1:5599',
    );
  });

  it('trims the trailing punctuation a wrapper leaves behind', () => {
    // Drizzle's message ends `params:`, which joined naively reads `params:: …`.
    const cause = new Error('connect ECONNREFUSED 127.0.0.1:5599');
    expect(describeError(new Error('Failed query: select 1\nparams:', { cause }))).toBe(
      'Failed query: select 1\nparams: connect ECONNREFUSED 127.0.0.1:5599',
    );
  });

  it('reads a plain error unchanged', () => {
    expect(describeError(new Error('statement timeout'))).toBe('statement timeout');
  });

  it('reads a thrown non-Error', () => {
    expect(describeError('a bare string')).toBe('a bare string');
    expect(describeError(undefined)).toBe('undefined');
  });

  it('does not say the same thing twice', () => {
    const cause = new Error('same');
    expect(describeError(new Error('same', { cause }))).toBe('same');
  });

  it('skips a wrapper with nothing to say', () => {
    const cause = new Error('the real problem');
    expect(describeError(new Error('', { cause }))).toBe('the real problem');
  });

  it('falls back to the error name when nothing in the chain has a message', () => {
    expect(describeError(new RangeError(''))).toBe('RangeError');
  });

  it('stops following a chain rather than walking one that loops', () => {
    // A driver that sets `cause` to something self-referential must not turn a
    // health check into an infinite loop.
    const looped = new Error('outer');
    (looped as { cause?: unknown }).cause = looped;
    expect(describeError(looped)).toBe('outer');
  });

  it('follows a driver error nested behind more than one wrapper', () => {
    const root = new Error('password authentication failed');
    const middle = new Error('pool acquire failed', { cause: root });
    expect(describeError(new Error('Failed query: select 1', { cause: middle }))).toBe(
      'Failed query: select 1: pool acquire failed: password authentication failed',
    );
  });
});
