# Handoff: Ghalla Ops — internal operator console

## Overview
An internal operator portal for **Ghalla**, a profit-analytics app sold to e-commerce merchants through platform app stores (Salla first, Zid next). Audience is **one person** — the solo founder. No onboarding, no empty-state hand-holding, no permissions, no team features. The design optimises for information density and speed of diagnosis: "is something wrong?" and "what do I do next?".

Six views: Overview, Stores, Store detail, Health, Revenue, Review queues, plus a narrow read-only Overview for phone.

## About the design files
`Ghalla Ops.dc.html` in this bundle is a **design reference written as a single HTML prototype** — it shows intended look, density and behaviour. It is not production code to copy. Recreate it in the target codebase using that codebase's existing framework, component library and conventions (React + Tailwind + shadcn/ui is a natural fit — the structure maps 1:1 onto Card / Table / Badge / Dialog / Command / Tabs / Progress). If no app exists yet, pick the framework and scaffold it.

Open the file in a browser to interact with it: sidebar navigation, row → store detail, the "needs attention" filter, ⌘K command palette, and action → confirm dialog all work.

## Fidelity
**High fidelity.** Colours, type, spacing, radii and copy are final. Recreate pixel-close at a 1440px primary target, using the codebase's own primitives.

## Design tokens

### Colour
| Role | Value |
| --- | --- |
| Page ground | `#F5F6FA` |
| Outer body ground | `#EDEEF3` |
| Card surface | `#FFFFFF` |
| Sidebar rail | `#FBFBFD` |
| Card border | `#EFF0F5` |
| Divider (inside card) | `#EFF0F5`; row rule `#F2F3F7` |
| Subtle surface (table head, chips) | `#F5F6FA` / `#F7F8FB` |
| Bar track | `#E6E8EF` |
| Text ink | `#1F2430` |
| Text muted | `#5A6070` |
| Icon / tertiary | `#A6ABBA` |
| Primary (accent) | `#5B5FE0`, hover `#4A4ECB`, deep `#3A3D9E`, tint `#EEF0FD` |
| Accent surface (hero cards) | `#4A4ECB` with `#FFFFFF` ink, `#E8E9FD` muted, `#6B6FE3` divider |
| Secondary chart series | `#F5A04A` (orange), light indigo `#C7C9F7`, light orange `#FBC98A` |
| Success | text `#15803D`, fill `#DCFCE7`, dot `#22C55E` |
| Warning | text `#B45309`, fill `#FEF3C7`, dot/bar `#F59E0B`, row ground `#FFFBF0` |
| Danger | text `#B42318`, fill `#FEE4E2`, dot/bar `#EF4444`, row ground `#FEF5F4`, badge `#D92D20`, on-accent `#FECDCA` |
| Info (Phase 2 chip) | text `#3A3D9E`, fill `#EEF0FD` |

Contrast rule enforced throughout: any text at 9.5–13px clears 4.5:1 on its own ground. Muted text is never lighter than `#5A6070` on white/near-white, and `#E8E9FD` on the indigo cards.

### Type
- Family: **Montserrat** (400/500/600/700/800), `font-variant-numeric: tabular-nums` on the root so columns of figures align.
- `IBM Plex Mono` only for code-like strings: job error messages, the confirm-dialog target line, raw queue values, the ⌘K chip.
- Scale in use: 9.5px caps kickers (letter-spacing .09–.12em, weight 800) · 10–10.5px chips/badges (weight 800) · 11–11.5px meta and timestamps · 12–12.5px table cells and list rows · 13px card titles and nav · 13–14px section titles (800) · 15–20px headings · 22–34px figures (800, letter-spacing −0.02/−0.03em).

### Spacing / shape
- Card radius **14px** (mobile hero 16px, phone frame 26px); pills/buttons **11–12px**; chips 5–6px.
- Card header padding `11–12px 14px`; card body `12–14px`; table cells `9px 10px` (Revenue tables `9px 14px`); grid gaps **12px** (14px on Overview).
- Card shadow: `0 1px 2px rgba(31,36,48,0.04), 0 6px 18px rgba(31,36,48,0.05)`. Modals: `0 24px 60px rgba(0,0,0,0.66)` over a `rgba(0,0,0,0.72)` backdrop.
- Shell: sidebar fixed **212px**; content max target **1440px**; topbar `14px 20px`; content padding `16px 20px 26px`.

## Shell

**Sidebar** (#FBFBFD, 1px right border #EDEEF3): brand tile (30px, radius 9px, `#5B5FE0` on white "G") + "GHALLA / OPS CONSOLE" (9.5px caps, letter-spacing .16em). Nav grouped under caps kickers — **Monitor** (Overview, Stores·312, Health·badge 3) · **Business** (Revenue, Review queues·10) · **Views** (Narrow overview). Item: 9px 10px, radius 12px, 15px Lucide icon + 13px label; inactive `#5A6070` weight 500; active = `#EEF0FD` fill with `#3A3D9E` label/icon at weight 700; hover `#F2F3F7`. Footer: "Jump to store" card with ⌘K chip, then operator identity ("Amman · UTC+3").

**Topbar** (white, 1px bottom border): screen title (18px/800) + one-line subtitle; right side = 24h/7d/30d/90d segmented control (active pill `#5B5FE0` with white label, inactive `#5A6070`), then "Updated 2m ago" with a manual refresh icon. **Nothing auto-refreshes** — that is a deliberate product decision; keep the visible last-updated stamp.

## Screens

### 1. Overview
- **Health strip** — 4 equal cards (Salla, Zid, Workers, Nightly recon): status dot with 3px halo, name, state chip (LIVE / DEGRADED / OK / ATTENTION), "WEBHOOK 24H" kicker + 19px figure, a 14-bar sparkline (4px bars, 2px radius, per-card ink), then a rule and Queue / Failed / lag microstats.
- **Alert feed** — the most important element. Rows: 3px left severity bar, 24px glyph tile, title (13px/700) + detail (11.5px), right-aligned store + relative time (absolute in `title`), severity chip, chevron. Six alerts, most severe first: silent store · platform webhook rate · stuck backfill · coverage drop · past-due subscriptions · order cap. Click → store detail.
- **Right rail** — indigo hero card (MRR 32px, delta chip, Paid/Trialing/Past due) + Activation funnel (Installed → Backfill complete → Cost data entered → Activated → Paid, each with count, drop-off % and a 7px bar).
- **Recent installs / Recent churns** — two 5-row lists side by side.

### 2. Stores
Filter bar (search field, Platform/Plan/Status selects, "Needs attention only" toggle) + saved-view chips (Trialing 37, Over cap 3, Past due 6, Low coverage 48, Silent 4, + Save this view) and a "Showing N of 312" count.

Table, sticky header, max-height 640px, full row clickable: Store (name + mono domain, with a ▲ marker for problem rows) · Platform · Plan · Status chip · Installed · Orders · Cap use (44px bar + %) · Coverage % · Last webhook · Health (dot + label). Problem rows read differently **without relying on colour**: tinted ground (`#FEF5F4` bad / `#FFFBF0` warn), an `inset 3px 0` left bar, and the ▲ glyph.

### 3. Store detail
Header (back button, name, status + plan chips, platform · install date · currency · **both timezones** · storefront link, and right-aligned MRR / Coverage / Last sync). Then: **Subscription** (period, trial end, renews, plan history) · **Ingestion health** (received/processed/failed, 24-bar series, backfill progress with a STUCK state, last sync per entity) · **Data quality** (31% coverage, CHURN RISK chip, SKUs missing cost, estimated shipping/fees, fully costed) · **Activity** (30-day bar chart, profit records, dashboard sessions) · **Operator actions** — visually quarantined panel (`#FEF5F4` ground, `#FECDCA` border): recompute, re-run backfill, replay webhook, force reconciliation. Every action opens a confirm dialog with a mono target line and a red primary.

### 4. Health
Five stat cards (events received, processed, dropped stale, signature failures, failed jobs) · stacked 36-column queue chart (Salla depth / Zid depth / retry queue) with a "now · 14:24 Asia/Amman" axis · Failed jobs table (job + mono error, store, retries, last, Retry button) · Webhook events funnel with percentages · Nightly reconciliation trend with a RISING chip · Platform API error and 429 rates.

### 5. Revenue
MRR line (SVG polyline, indigo, dashed red churn series, grid rules) with New / Expansion / Churn / ARPA · By plan and By platform bars · Trial→paid conversion by month (9 bars, last one emphasised) · Churn table (tenure + final coverage — the churn predictor) · 10-month cohort retention grid, 4-step indigo ramp, upper-triangle only.

### 6. Review queues
Shared queue pattern: raw value (mono) · context · occurrence count · one primary action · dismiss ×. Header carries the count and a progress bar so the queue reads finishable. "Unknown payment method labels" is live (7 items); "Unmatched campaigns" is the same pattern at 50% opacity with a PHASE 2 chip.

### 7. Narrow overview (390px, read-only)
Same order as desktop: platform rows, alerts (no links), indigo MRR card, funnel counts. No filters, tables or actions — "there is nothing to do from a phone but know."

## Interactions & behaviour
- Sidebar nav switches views; store rows and alerts open Store detail.
- **⌘K / Ctrl+K** opens the command palette (fuzzy store search, Escape closes). Escape also closes the confirm dialog.
- Time range 24h/7d/30d/90d applies wherever a series appears.
- Timestamps relative by default, absolute + timezone in `title` on hover. Operator is in Asia/Amman; stores are in Gulf timezones — always label which.
- Currency SAR, shown once per context, never per cell.
- "Needs attention only" filters the store list (14 → 9 rows).
- Destructive-adjacent actions always confirm; the dialog states that it hits production and cannot be undone from the console.
- Loading is **per section**, never page-blocking; one section can fail while the rest stays live.

## State
`screen` · `range` · `attention` (filter toggle) · `palette` + `query` · `confirm` (action descriptor or null) · `store` (selected store name). Prototype-level flags for the briefed edge states: `alertsClear`, `zeroStores`, `railState: normal | loading | failed`.

## States to build
1. **Alert feed empty** — the good state and the most common: a green check tile with "All clear across Salla and Zid" plus the counts. Must read as confident, not broken.
2. **Zero stores** — first week after launch; explains that installs appear within seconds of the first OAuth callback.
3. **Every problem state** on a store row — silent, over cap, past due, stuck backfill, zero coverage.
4. **Partial loading** — shimmer skeleton in one section while others are live.
5. **Section failure** — bordered error card with the error string, timestamp, "Retry section" and "Show cached (2h old)".

## Assets
None. Icons are inline Lucide paths at 12–20px, `stroke-width: 2`. Fonts: Montserrat and IBM Plex Mono from Google Fonts. No imagery, no avatars.

## Files
- `Ghalla Ops.dc.html` — the full prototype, all six views plus the narrow view and edge states.
