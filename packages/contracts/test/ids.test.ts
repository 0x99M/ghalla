import { describe, expect, it } from 'vitest';
import {
  MalformedIdError,
  toCustomerRef,
  toOrderId,
  toOrderItemId,
  toPlatformId,
  toStoreId,
} from '../src/ids.js';

const platform = toPlatformId('example_platform');
const store = toStoreId(platform, '12345');

describe('identifier derivation', () => {
  it('is deterministic, which is what makes at-least-once webhook delivery safe', () => {
    expect(toOrderId(store, '999')).toBe(toOrderId(store, '999'));
    expect(toOrderId(store, '999')).toBe('example_platform:12345:999');
  });

  it('keeps two stores on one platform apart', () => {
    const other = toStoreId(platform, '54321');
    expect(toOrderId(store, '999')).not.toBe(toOrderId(other, '999'));
  });

  it('refuses separator characters, so two platform entities cannot collide onto one id', () => {
    expect(() => toOrderId(store, '99:9')).toThrow(MalformedIdError);
    expect(() => toOrderItemId(toOrderId(store, '999'), 'a#b')).toThrow(MalformedIdError);
    expect(() => toStoreId(platform, '')).toThrow(MalformedIdError);
  });
});

describe('toPlatformId', () => {
  it('accepts a lowercase slug and rejects anything shaped like a display name', () => {
    expect(toPlatformId('some_platform')).toBe('some_platform');
    expect(() => toPlatformId('Some Platform')).toThrow(MalformedIdError);
  });
});

describe('toCustomerRef', () => {
  it('accepts only a full-length lowercase hex digest', () => {
    const digest = 'a'.repeat(64);
    expect(toCustomerRef(digest)).toBe(digest);
    expect(() => toCustomerRef('a'.repeat(63))).toThrow(MalformedIdError);
    expect(() => toCustomerRef('A'.repeat(64))).toThrow(MalformedIdError);
    expect(() => toCustomerRef('12345')).toThrow(MalformedIdError);
  });
});
