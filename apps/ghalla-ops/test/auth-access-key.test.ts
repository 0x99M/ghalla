import { describe, expect, it } from 'vitest';
import {
  AuthConfigError,
  DEFAULT_SESSION_TTL_MS,
  MIN_ACCESS_KEY_LENGTH,
  accessKeyMatches,
  loadAuthConfig,
  timingSafeEqual,
} from '../src/lib/auth/access-key';

const KEY = 'x'.repeat(MIN_ACCESS_KEY_LENGTH);

describe('loadAuthConfig', () => {
  it('reads the key and the session lifetime', () => {
    expect(loadAuthConfig({ OPS_ACCESS_KEY: KEY })).toEqual({
      accessKey: KEY,
      sessionTtlMs: DEFAULT_SESSION_TTL_MS,
    });
  });

  it('refuses to start with no key at all', () => {
    expect(() => loadAuthConfig({})).toThrow(AuthConfigError);
    expect(() => loadAuthConfig({ OPS_ACCESS_KEY: '   ' })).toThrow(/will not serve/);
  });

  it('refuses a key short enough to be guessed', () => {
    // The load-bearing control. A rate limiter slows an attacker down; length
    // is what makes the attempt pointless, and a portal holding every
    // merchant's business data must not start behind a memorable string.
    expect(() => loadAuthConfig({ OPS_ACCESS_KEY: 'x'.repeat(MIN_ACCESS_KEY_LENGTH - 1) })).toThrow(
      /at least 32 characters/,
    );
  });
});

describe('timingSafeEqual', () => {
  it('is true for identical bytes', () => {
    expect(timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(true);
  });

  it('is false for a difference anywhere, including the last byte', () => {
    expect(timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([9, 2, 3]))).toBe(false);
    expect(timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 9]))).toBe(false);
  });

  it('is false for a different length without short-circuiting on it', () => {
    // Folded into the same accumulator, so a wrong-length guess is not
    // distinguishable from a wrong-value one by how long the answer took.
    expect(timingSafeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3]))).toBe(false);
    expect(timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2]))).toBe(false);
  });

  it('is true for two empty arrays', () => {
    expect(timingSafeEqual(new Uint8Array(), new Uint8Array())).toBe(true);
  });
});

describe('accessKeyMatches', () => {
  it('accepts the configured key', async () => {
    await expect(accessKeyMatches(KEY, KEY)).resolves.toBe(true);
  });

  it('rejects a wrong key of the same length', async () => {
    await expect(accessKeyMatches('y'.repeat(MIN_ACCESS_KEY_LENGTH), KEY)).resolves.toBe(false);
  });

  it('rejects a prefix of the right key', async () => {
    await expect(accessKeyMatches(KEY.slice(0, -1), KEY)).resolves.toBe(false);
  });

  it('rejects an empty presentation', async () => {
    await expect(accessKeyMatches('', KEY)).resolves.toBe(false);
  });
});
