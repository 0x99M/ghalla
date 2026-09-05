import { MAX_MINOR, toMinor } from '@ghalla/contracts';
import type { Bps, Minor } from '@ghalla/contracts';

/**
 * The money kernel — the most test-worthy module in the repository.
 *
 * Every number a merchant sees passes through these functions. Their behaviour
 * is a domain decision rather than an implementation detail: the rounding mode
 * and the allocation algorithm are both visible in the dashboard.
 *
 * They throw on inputs that cannot occur if `normalizeAndValidate` did its job.
 * `computeOrderProfit` catches at the top level and returns a rejected result,
 * so the engine stays total without any of these functions having to invent a
 * plausible number for impossible input.
 */

export class MoneyKernelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyKernelError';
  }
}

const SAFE = Number.MAX_SAFE_INTEGER;

/** Sums with an explicit range check, so a bad input fails loudly rather than losing precision. */
export function addMinor(...values: readonly Minor[]): Minor {
  let total = 0;
  for (const value of values) {
    total += value;
    if (!Number.isSafeInteger(total)) {
      throw new MoneyKernelError(`Sum left the safe-integer range at ${String(total)}.`);
    }
  }
  return toMinor(total);
}

export function subMinor(a: Minor, b: Minor): Minor {
  return toMinor(a - b);
}

/** Sign flip that normalizes negative zero, so `-0` never enters a result. */
export function negateMinor(value: Minor): Minor {
  return toMinor(value === 0 ? 0 : -value);
}

/**
 * Integer division rounding HALF AWAY FROM ZERO.
 *
 * Not `Math.round`, which is half-UP: `Math.round(-1.5)` is `-1`, so a charge
 * and its exact reversal differ by one halala and every refunded order leaves a
 * residue behind. Half-away-from-zero makes `f(-x) === -f(x)` hold, which is
 * the property that lets a reversal undo a charge exactly.
 */
function divRoundHalfAwayFromZero(numerator: number, denominator: number): number {
  // `NaN <= 0` is false, so a bare `<= 0` lets the worst possible divisor past
  // the one check that exists for it.
  if (!Number.isSafeInteger(denominator) || denominator <= 0) {
    throw new MoneyKernelError(`Divisor must be a positive integer; received ${String(denominator)}.`);
  }
  if (!Number.isSafeInteger(numerator)) {
    throw new MoneyKernelError(
      `Intermediate ${String(numerator)} left the safe-integer range, where the arithmetic stops ` +
        `being exact silently. This is the failure mode integer money exists to prevent.`,
    );
  }
  const negative = numerator < 0;
  const abs = negative ? -numerator : numerator;
  const whole = Math.floor(abs / denominator);
  const remainder = abs - whole * denominator;
  const rounded = remainder * 2 >= denominator ? whole + 1 : whole;
  return negative ? -rounded : rounded;
}

/**
 * `value × bps / 10_000`, rounded half away from zero.
 *
 * `MAX_MINOR` is chosen precisely so that `value * 10_000` stays inside
 * `Number.MAX_SAFE_INTEGER`; a rate above 100% can still exceed it, and does so
 * loudly rather than silently.
 */
export function mulBps(value: Minor, bps: Bps): Minor {
  // The product guard below cannot catch a fractional rate: `value * 2.75` lands
  // on an integer for roughly half of all baskets, so a merchant who typed their
  // 2.75% as `2.75` would get a silently 100x-wrong fee on those orders and a
  // dead-letter on the rest, partitioned by the parity of the basket amount.
  if (!Number.isSafeInteger(bps)) {
    throw new MoneyKernelError(
      `A rate must be an integer count of basis points; received ${String(bps)}. ` +
        `2.75% is 275, not 2.75.`,
    );
  }
  return toMinor(divRoundHalfAwayFromZero(value * bps, 10_000));
}

/** `null` on either side means unbounded there. The cap wins if a caller supplies min > max. */
export function clampMinor(value: Minor, min: Minor | null, max: Minor | null): Minor {
  // A NaN bound makes both comparisons false and removes the clamp entirely,
  // which is the opposite of what a bound is for.
  if ((min !== null && !Number.isFinite(min)) || (max !== null && !Number.isFinite(max))) {
    throw new MoneyKernelError(`Fee bounds must be finite; received min=${String(min)} max=${String(max)}.`);
  }
  let out: number = value;
  if (min !== null && out < min) out = min;
  if (max !== null && out > max) out = max;
  return toMinor(out);
}

/**
 * Splits a VAT-inclusive gross amount into net and VAT.
 *
 * The VAT is the RESIDUAL — `vat = gross - net` — rather than a second
 * independent rounding, so `net + vat === gross` holds by construction. Two
 * separately rounded halves of one amount do not reliably sum back to it.
 */
export function splitVatInclusive(gross: Minor, vatRateBps: Bps): { readonly net: Minor; readonly vat: Minor } {
  if (vatRateBps < 0) {
    throw new MoneyKernelError(`A VAT rate may not be negative; received ${String(vatRateBps)} bps.`);
  }
  const net = toMinor(divRoundHalfAwayFromZero(gross * 10_000, 10_000 + vatRateBps));
  return { net, vat: subMinor(gross, net) };
}

export interface AllocationBucket {
  readonly key: string;
  /** Negative weights are clamped to zero: a negative share of a cost is not a thing. */
  readonly weight: Minor;
}

/**
 * Distributes a total across weighted buckets by LARGEST REMAINDER, preserving
 * `Σ(allocated) === total` EXACTLY.
 *
 * This is not a detail. Naive proportional allocation with the remainder pushed
 * onto the last line produces a NEGATIVE allocation for a small total spread
 * over many equal lines — a phantom surcharge that flips a SKU's margin sign
 * and fires a false loss-maker flag, which is a headline feature of the
 * product. Largest remainder keeps every share within one minor unit of exact
 * and the sum precise.
 *
 * Ties break on remainder descending, then weight descending, then key
 * ascending — never on array index, so re-ingesting an order whose lines
 * arrive in a different order yields identical per-SKU numbers.
 *
 * When every weight is zero there is no revenue basis to divide by, so the
 * total is split as evenly as it divides. That is the 100%-discount order, and
 * it must still tie.
 */
export function allocateMinor(
  total: Minor,
  buckets: readonly AllocationBucket[],
): ReadonlyMap<string, Minor> {
  const out = new Map<string, Minor>();
  if (buckets.length === 0) {
    if (total !== 0) {
      throw new MoneyKernelError(
        `Cannot allocate ${String(total)} across zero buckets without breaking the sum invariant. ` +
          `An order with no lines keeps its order-level amounts in the totals.`,
      );
    }
    return out;
  }

  const seen = new Set<string>();
  for (const bucket of buckets) {
    if (seen.has(bucket.key)) {
      throw new MoneyKernelError(`Duplicate allocation key ${JSON.stringify(bucket.key)}.`);
    }
    seen.add(bucket.key);
  }

  const negative = total < 0;
  const magnitude = BigInt(negative ? -total : total);

  // Weight carried ALONGSIDE its bucket rather than in a parallel array read
  // back by index. The index form needed a `?? 0n` for a subscript that cannot
  // be out of range — an unreachable branch standing exactly where a reader
  // expects a decision about money.
  const weighted = buckets.map((bucket) => ({
    bucket,
    raw: bucket.weight > 0 ? BigInt(bucket.weight) : 0n,
  }));
  const weightSum = weighted.reduce((sum, w) => sum + w.raw, 0n);
  // All-zero weights: no revenue basis, so divide evenly. Weight 1 each.
  const even = weightSum === 0n;
  const denominator = even ? BigInt(buckets.length) : weightSum;

  const rows = weighted.map(({ bucket, raw }) => {
    const weight = even ? 1n : raw;
    const numerator = magnitude * weight;
    const base = numerator / denominator;
    return { key: bucket.key, base, remainder: numerator - base * denominator, weight };
  });

  const distributed = rows.reduce((sum, row) => sum + row.base, 0n);
  let shortfall = magnitude - distributed;

  const order = [...rows].sort((a, b) => {
    if (a.remainder !== b.remainder) return a.remainder > b.remainder ? -1 : 1;
    if (a.weight !== b.weight) return a.weight > b.weight ? -1 : 1;
    // No equal case: duplicate keys are rejected before this runs, so a third
    // arm here would be unreachable and would imply an ordering question that
    // cannot arise.
    return a.key < b.key ? -1 : 1;
  });

  const extra = new Map<string, bigint>();
  for (const row of order) {
    if (shortfall <= 0n) break;
    extra.set(row.key, 1n);
    shortfall -= 1n;
  }

  for (const row of rows) {
    const amount = row.base + (extra.get(row.key) ?? 0n);
    if (amount > BigInt(MAX_MINOR)) {
      throw new MoneyKernelError(`Allocated share ${String(amount)} exceeds the money range.`);
    }
    out.set(row.key, toMinor(negative ? -Number(amount) : Number(amount)));
  }
  return out;
}

/**
 * `numerator / denominator`, rounded half away from zero. Exported so
 * `marginBpsOf` uses the same rounding as the money it describes rather than a
 * hand-rolled copy that has already drifted once.
 */
export function divRoundHalfAway(numerator: number, denominator: number): number {
  return divRoundHalfAwayFromZero(numerator, denominator);
}

/** Guards a value that arithmetic produced rather than a constructor. */
export function assertInRange(value: number, label: string): Minor {
  if (!Number.isSafeInteger(value) || value > MAX_MINOR || value < -MAX_MINOR) {
    throw new MoneyKernelError(`${label} is out of the money range: ${String(value)}.`);
  }
  return toMinor(value);
}

export { SAFE as SAFE_INTEGER_CEILING };
