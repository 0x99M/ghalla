import { describe, expect, it } from 'vitest';
import { cn } from '../src/lib/ui/cn';

describe('cn', () => {
  it('drops falsy branches', () => {
    const off = 'b' as string | false;
    expect(cn('a', off === 'b' ? false : off, undefined, null, 'c')).toBe('a c');
  });

  it('lets a later utility beat an earlier one', () => {
    // Without the merge these both survive and the stylesheet's source order
    // decides — the bug where an override works on one component and not its
    // neighbour.
    expect(cn('px-2', 'px-4')).toBe('px-4');
    expect(cn('text-muted', 'text-ink')).toBe('text-ink');
  });

  it('keeps utilities that do not conflict', () => {
    expect(cn('flex items-center', 'gap-2')).toBe('flex items-center gap-2');
  });
});
