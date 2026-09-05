import { describe, expect, it } from 'vitest';
import { NAV_GROUPS, NAV_ITEMS, OVERVIEW_SCREEN, isActive, screenMeta } from '../src/lib/ui/nav';

describe('isActive', () => {
  it('lights Overview only on the root', () => {
    expect(isActive('/', '/')).toBe(true);
    expect(isActive('/', '/stores')).toBe(false);
    // The whole reason `/` is special-cased: every path starts with it.
    expect(isActive('/', '/revenue')).toBe(false);
  });

  it('keeps a section lit inside its own subtree', () => {
    expect(isActive('/stores', '/stores')).toBe(true);
    expect(isActive('/stores', '/stores/salla/salla%3A99')).toBe(true);
    expect(isActive('/queues', '/queues/unknown-payment-methods')).toBe(true);
  });

  it('does not light a section on a path that merely shares its prefix', () => {
    // `/storefronts` is not inside `/stores`, and a `startsWith` without the
    // separator would say it was.
    expect(isActive('/stores', '/storefronts')).toBe(false);
  });
});

describe('screenMeta', () => {
  it('names every screen a nav item points at', () => {
    for (const item of NAV_ITEMS) {
      const meta = screenMeta(item.href);
      expect(meta.title.length).toBeGreaterThan(0);
      expect(meta.subtitle.length).toBeGreaterThan(0);
    }
  });

  it('keeps the section title on a nested route', () => {
    expect(screenMeta('/stores/salla/salla%3A99').title).toBe('Stores');
    expect(screenMeta('/queues/unknown-payment-methods').title).toBe('Review queues');
  });

  it('falls back to the overview rather than rendering an empty header', () => {
    expect(screenMeta('/nothing-here')).toStrictEqual(OVERVIEW_SCREEN);
  });
});

describe('NAV_ITEMS', () => {
  it('assigns every item to a declared group', () => {
    for (const item of NAV_ITEMS) {
      expect(NAV_GROUPS).toContain(item.group);
    }
  });

  it('has no duplicate hrefs', () => {
    expect(new Set(NAV_ITEMS.map((item) => item.href)).size).toBe(NAV_ITEMS.length);
  });
});
