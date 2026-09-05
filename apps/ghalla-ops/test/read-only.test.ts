import { describe, expect, it } from 'vitest';
import { asReadOnly } from '../src/lib/platforms/read-only';

/**
 * The type is the assertion here and it is checked by the compiler, not by this
 * file: `ReadOnlyDatabase` has no `insert`, so a write inside the portal does
 * not compile. What is left to test at runtime is that the boundary does not
 * wrap or copy anything — the handle that comes out is the one that went in.
 */
describe('asReadOnly', () => {
  it('narrows the type without changing the object', () => {
    const db = { select: () => 'selected' };
    expect(asReadOnly(db as never)).toBe(db);
  });
});
