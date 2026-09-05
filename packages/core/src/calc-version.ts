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
 * CI fails the build if any golden fixture's expected output changed and this
 * did not. Without that check the failure is silent: someone changes a rounding
 * mode, regenerates the fixtures, and the database now holds two different
 * calculations under one version with no way to tell them apart.
 */
export const CALC_VERSION: CalcVersion = toCalcVersion(1);
