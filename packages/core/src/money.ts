import type { Bps, Minor } from '@ghalla/contracts';
import { NotImplementedError } from './not-implemented.js';

/**
 * The money kernel — the most test-worthy module in the repository.
 *
 * Every number a merchant sees passes through these five functions. They are
 * declared here, ahead of the engine, because their behaviour is a domain
 * decision rather than an implementation detail: the rounding mode and the
 * allocation algorithm are visible in the merchant's dashboard.
 */

/** Sums with an explicit overflow check, so a bad input fails loudly rather than losing precision silently. */
export function addMinor(..._values: readonly Minor[]): Minor {
  throw new NotImplementedError('addMinor');
}

/** Sign flip that normalizes negative zero, so `-0` never enters a result. */
export function negateMinor(_value: Minor): Minor {
  throw new NotImplementedError('negateMinor');
}

/**
 * `value × bps / 10_000`, rounded HALF AWAY FROM ZERO.
 *
 * Not `Math.round`, which is half-UP: `Math.round(-1.5) === -1`, so a symmetric
 * charge and its reversal differ by one halala and every refunded order leaves a
 * residue. Half-away-from-zero makes `f(-x) === -f(x)` hold, which is the
 * property that lets a reversal exactly undo a charge.
 *
 * Asserts that the intermediate stays inside the safe-integer range rather than
 * letting it degrade silently — the one failure mode integer money exists to
 * prevent.
 */
export function mulBps(_value: Minor, _bps: Bps): Minor {
  throw new NotImplementedError('mulBps');
}

/**
 * `min(max(value, min), max)` — the cap wins when a caller supplies
 * `min > max`, which is a caller defect rather than a representable state.
 * Stated because a rate card's floor and cap are transcribed by hand and the
 * order of the two operations changes the fee on every order under that rule.
 * `null` on either side means unbounded on that side.
 */
export function clampMinor(_value: Minor, _min: Minor | null, _max: Minor | null): Minor {
  throw new NotImplementedError('clampMinor');
}

/**
 * Splits a VAT-inclusive gross amount into net and VAT.
 *
 * The VAT is returned as the RESIDUAL — `vat = gross - net` — rather than
 * computed independently, so `net + vat === gross` holds by construction rather
 * than by luck. Two independently rounded halves of one amount do not reliably
 * sum back to it.
 */
export function splitVatInclusive(_gross: Minor, _vatRateBps: Bps): { readonly net: Minor; readonly vat: Minor } {
  throw new NotImplementedError('splitVatInclusive');
}

/**
 * Distributes a total across weighted buckets by LARGEST REMAINDER, preserving
 * `Σ(allocated) === total` exactly.
 *
 * This is not a detail. Naive proportional allocation with the remainder pushed
 * onto the last line produces a NEGATIVE allocation for small totals over many
 * equal lines — a phantom surcharge that flips a SKU's margin sign and fires a
 * false loss-maker flag, which is a headline feature of the product. Largest
 * remainder keeps every share within one minor unit of exact and the sum precise.
 *
 * Ties break on remainder descending, then weight descending, then key ascending
 * — never on array index, so re-ingesting an order whose lines arrive in a
 * different order yields identical per-SKU numbers.
 */
export function allocateMinor(
  _total: Minor,
  _buckets: readonly { readonly key: string; readonly weight: Minor }[],
): ReadonlyMap<string, Minor> {
  throw new NotImplementedError('allocateMinor');
}
