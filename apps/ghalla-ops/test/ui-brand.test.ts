import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isPublicPath } from '../src/lib/auth/guard';
import { BRAND_ASSETS, MARK, MARK_GRID, WORDMARK, markCell } from '../src/lib/ui/brand';

/** The kit at the repository root, and the directory the console serves. */
const KIT = new URL('../../../brand/', import.meta.url);
const PUBLIC = new URL('../public/', import.meta.url);

function read(base: URL, relative: string): Buffer {
  return readFileSync(fileURLToPath(new URL(relative, base)));
}

/** `/brand/x.svg` → `brand/x.svg`, so it resolves under `public/` and not `/`. */
function served(href: string): string {
  return href.slice(1);
}

describe('BRAND_ASSETS', () => {
  it('serves every asset as a byte-for-byte copy of the kit', () => {
    for (const [name, asset] of Object.entries(BRAND_ASSETS)) {
      const copy = read(PUBLIC, served(asset.href));
      const source = read(KIT, asset.source);
      expect(copy.equals(source), `${name}: ${asset.href} differs from brand/${asset.source}`).toBe(true);
    }
  });

  it('holds nothing under public/brand/ that the kit did not supply', () => {
    const onDisk = readdirSync(fileURLToPath(new URL('brand/', PUBLIC))).sort();
    const declared = Object.values(BRAND_ASSETS)
      .map((asset) => asset.href.slice('/brand/'.length))
      .sort();
    expect(onDisk).toStrictEqual(declared);
  });

  it('serves each asset at its own URL', () => {
    const hrefs = Object.values(BRAND_ASSETS).map((asset) => asset.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  it('is reachable before login, because the login page shows it', () => {
    // The middleware is closed by default. An asset the guard does not open
    // renders as a redirect to the login page — a broken logo on the one
    // screen that exists to be seen before a session.
    for (const asset of Object.values(BRAND_ASSETS)) {
      expect(isPublicPath(asset.href), asset.href).toBe(true);
    }
  });
});

describe('the mark', () => {
  it('renders at a size where every cell lands on whole pixels', () => {
    expect(Number.isInteger(markCell(MARK.size))).toBe(true);
    expect(Number.isInteger((MARK.size * MARK_GRID.gap) / MARK_GRID.extent)).toBe(true);
  });

  it('keeps the clear space the kit asks for: one cell on every side', () => {
    expect(MARK.clearSpace).toBeGreaterThanOrEqual(markCell(MARK.size));
  });

  it('stays above the size where the kit switches to the mono mark', () => {
    expect(MARK.size).toBeGreaterThanOrEqual(24);
  });

  it('scales the cell with the mark', () => {
    // At the kit's own size a cell is the kit's own cell.
    expect(markCell(MARK_GRID.extent)).toBe(MARK_GRID.cell);
  });
});

describe('the wordmark', () => {
  it('is set in sentence case, never capitals', () => {
    expect(WORDMARK).toBe('Ghalla');
    expect(WORDMARK).not.toBe(WORDMARK.toUpperCase());
  });
});
