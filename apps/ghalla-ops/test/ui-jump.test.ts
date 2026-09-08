import { describe, expect, it } from 'vitest';
import { JUMP_LIMIT, moveHighlight, rankJump } from '../src/lib/ui/jump';

const store = (platformStoreId: string, platform = 'salla') => ({
  platform,
  platformStoreId,
  storeId: `${platform}:${platformStoreId}`,
});

// The order the API returns: busiest first.
const stores = [store('1240'), store('1024'), store('24'), store('2400', 'zid'), store('880')];

describe('rankJump', () => {
  it('shows the top of the list, in the list order, when nothing is typed', () => {
    expect(rankJump(stores, '').map((entry) => entry.platformStoreId)).toEqual(['1240', '1024', '24', '2400', '880']);
    expect(rankJump(stores, '   ')).toHaveLength(5);
  });

  it('puts the exact id first, then prefixes, then the rest, each in list order', () => {
    expect(rankJump(stores, '24').map((entry) => entry.platformStoreId)).toEqual(['24', '2400', '1240', '1024']);
  });

  it('matches the platform-qualified id and is case-insensitive', () => {
    expect(rankJump(stores, 'ZID:2400').map((entry) => entry.storeId)).toEqual(['zid:2400']);
    expect(rankJump(stores, 'Salla').map((entry) => entry.platform)).toEqual(['salla', 'salla', 'salla', 'salla']);
  });

  it('returns nothing for a query nothing contains', () => {
    expect(rankJump(stores, 'shopify')).toEqual([]);
  });

  it('is capped, and the cap is the exported limit', () => {
    const many = Array.from({ length: 30 }, (_, index) => store(`s${String(index)}`));
    expect(rankJump(many, '')).toHaveLength(JUMP_LIMIT);
    expect(rankJump(many, 's', 3)).toHaveLength(3);
  });

  it('does not reorder within a tier', () => {
    // `1240` and `1024` both merely contain `2`; `24`, `2400` start with it.
    expect(rankJump(stores, '2').map((entry) => entry.platformStoreId)).toEqual(['24', '2400', '1240', '1024']);
  });
});

describe('moveHighlight', () => {
  it('moves within the list and stops at the ends', () => {
    expect(moveHighlight(0, 1, 3)).toBe(1);
    expect(moveHighlight(2, 1, 3)).toBe(2);
    expect(moveHighlight(0, -1, 3)).toBe(0);
  });

  it('lands on the first row from no highlight', () => {
    expect(moveHighlight(-1, 1, 3)).toBe(0);
  });

  it('has no highlight in an empty list', () => {
    expect(moveHighlight(0, 1, 0)).toBe(-1);
    expect(moveHighlight(-1, -1, 0)).toBe(-1);
  });
});
