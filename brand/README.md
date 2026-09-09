# Ghalla — mark 4F "Matrix"

Nine cells on a 3×3 grid; the rising diagonal is ink, the cells below it are the light tone.
No outlines, no gradients, no rotation. The grid gap is always 25% of a cell.

## Colour

| Role | Hex |
| --- | --- |
| Ink | `#1E2632` |
| Lavender field | `#C68CFB` |
| White | `#FFFFFF` |

On the lavender field: ink diagonal + white support cells.
On white or light grey: ink diagonal + lavender support cells.
On ink: white diagonal + lavender support cells.
Single-colour printing, embroidery, favicons below 24px: use `mark-mono-*.svg` (all six cells one colour).

## Type

Wordmark is **Poppins SemiBold (600)**, letter-spacing −0.035em, sentence case — "Ghalla", never all caps.
The lockup SVGs contain live `<text>`; convert to outlines before sending to a printer, or keep Poppins installed.

## Clear space and minimum size

- Clear space on all sides = one cell (one third of the mark's height).
- Mark alone: minimum 16px. Below 24px use the mono version.
- Horizontal lockup: minimum 96px wide. Below that, use the mark alone.

## Files

### svg/ — use these wherever you can
- `mark-ink.svg` — mark for light backgrounds
- `mark-reverse.svg` — mark for dark backgrounds
- `mark-mono-ink.svg`, `mark-mono-white.svg` — single-colour
- `icon-lavender.svg` — app icon, lavender plate, 112/512 corner radius
- `icon-ink.svg`, `icon-white.svg` — app icon, alternate plates
- `lockup-horizontal-ink.svg`, `lockup-horizontal-reverse.svg` — mark + wordmark
- `lockup-stacked-ink.svg` — mark above wordmark, both flush left

### png/ — raster fallbacks, transparent where the plate is absent
- `icon-lavender-1024/512`, `icon-ink-1024/512`
- `apple-touch-icon-180`
- `favicon-64`, `favicon-32`, `favicon-16`
- `mark-ink-512/128`, `mark-reverse-512` (transparent)
- `lockup-horizontal-ink-1680`, `lockup-horizontal-reverse-1680`, `lockup-stacked-ink-960`

## Web snippet

```html
<link rel="icon" href="/favicon-32.png" sizes="32x32">
<link rel="icon" href="/svg/icon-lavender.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/apple-touch-icon-180.png">
```

## Don't

- Don't add a radius to the cells — they are square; only the app-icon plate is rounded.
- Don't recolour individual cells or introduce a third tone.
- Don't rotate, skew, or add a shadow.
- Don't set the wordmark in all caps or letterspace it open.

## In this repository

This directory is the kit, verbatim, and the only place the mark is drawn.

The operator console (`apps/ghalla-ops`) serves copies of four of these files
from `apps/ghalla-ops/public/brand/`. They are listed, each with the file here
it copies, in `apps/ghalla-ops/src/lib/ui/brand.ts`, and
`apps/ghalla-ops/test/ui-brand.test.ts` fails if a copy and its source ever
differ, or if a file appears under `public/brand/` that this kit did not supply.
To change what the console shows, change the file here and copy it over; the
test says whether the two agree. Nothing redraws the mark in markup, on purpose.
