import { toCalcVersion } from '@ghalla/contracts';
import type { CalcVersion } from '@ghalla/contracts';

/**
 * The stamp on every materialized profit row.
 *
 * A monotonic integer, never semver and never derived from a package version —
 * the only query ever run against it is `WHERE calc_version < $current`, and a
 * version bumped by an unrelated release would trigger a full recompute of every
 * store.
 *
 * Bump it when the arithmetic changes: a rounding mode, an allocation
 * algorithm, which terms enter the margin, or how confidence is derived. Do NOT
 * bump it for a comment, a rename, or a new diagnostic that fires on no
 * existing data.
 *
 * `scripts/check-calc-version.sh` fails the build when an existing golden
 * expectation is MODIFIED and this constant does not RISE — it reads the value,
 * not the file name, because a commit that merely reworded a comment here used
 * to satisfy a guard that only checked whether the file had been touched.
 * Adding a new fixture is not a change to any calculation already stored.
 *
 * Without that check the failure is silent: someone changes a rounding mode,
 * regenerates the fixtures, and the database holds two different calculations
 * under one version with no way to tell them apart.
 */
export const CALC_VERSION: CalcVersion = toCalcVersion(2);

/*
 * 2 — reversal COGS credit prorated and capped per line; per-line allocation
 *     weighted on item value rather than recognized revenue; freight attributed
 *     per parcel; return shipping attributed to returned lines; recognition
 *     extended to authorized / voided / failed / lost; gateway candidate
 *     selection fixed; COD priced per live carrier. Every stored row from
 *     version 1 must be recomputed.
 * 1 — first implementation.
 */
