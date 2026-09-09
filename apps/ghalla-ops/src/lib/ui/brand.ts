/**
 * The identity, as the console serves it.
 *
 * The kit lives at `brand/` in the repository root and is the only place the
 * mark is drawn. The console does not redraw it — not as inline SVG, not as
 * rects with token fills — because a redrawn logo is a second definition of
 * the logo, and the next revision of the kit would update one and not the
 * other. It serves byte-for-byte copies from `public/brand/` instead, and
 * `test/ui-brand.test.ts` holds every copy equal to its source in the kit.
 *
 * Each entry names the URL the console serves and the kit file it is a copy
 * of. Nothing else under `public/brand/` is allowed to exist: a file with no
 * source here is an asset nobody can trace back to the kit.
 */
export interface BrandAsset {
  /** The path the console serves, under `public/`. */
  readonly href: `/brand/${string}`;
  /** The file it is a copy of, relative to `brand/` in the repository root. */
  readonly source: string;
}

export const BRAND_ASSETS = {
  /** The mark on a light ground: ink diagonal, lavender support cells. */
  mark: { href: '/brand/mark-ink.svg', source: 'svg/mark-ink.svg' },
  /** The app icon — the mark on its lavender plate — as the scalable favicon. */
  icon: { href: '/brand/icon-lavender.svg', source: 'svg/icon-lavender.svg' },
  /** The 32px raster favicon, for the browsers that ignore an SVG one. */
  favicon: { href: '/brand/favicon-32.png', source: 'png/favicon-32.png' },
  /** The 180px icon iOS reads when the console is added to a home screen. */
  appleTouch: { href: '/brand/apple-touch-icon-180.png', source: 'png/apple-touch-icon-180.png' },
} as const satisfies Record<string, BrandAsset>;

/** The wordmark, as the kit sets it: sentence case, never capitals. */
export const WORDMARK = 'Ghalla';

/**
 * The mark's grid, from the kit: three cells of 24 on a pitch of 30, 84 in
 * all. The kit states its clear-space rule in this unit — one cell on every
 * side — so the console needs the cell size at whatever size it renders.
 */
export const MARK_GRID = { cell: 24, gap: 6, extent: 84 } as const;

/** One cell of the mark, in CSS pixels, when the mark is `size` pixels tall. */
export function markCell(size: number): number {
  return (size * MARK_GRID.cell) / MARK_GRID.extent;
}

/**
 * How the rail and the login page render the mark.
 *
 * 28 is not taste: it is 84 / 3, the size at which every cell is 8px and every
 * gap 2px, so the grid lands on whole pixels and the squares have edges rather
 * than a blur. The kit's minimum for the two-tone mark is 24 (mono below it),
 * so 28 is comfortably inside. The clear space beside it is one cell, 8px, by
 * the kit's rule, rounded up to the console's 10px gap.
 */
export const MARK = { size: 28, clearSpace: 10 } as const;
