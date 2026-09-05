import type { PlatformId } from '@ghalla/contracts';

/**
 * Thrown by adapter methods, not returned. Ports is the I/O layer, where
 * throwing is idiomatic; totality is a property of the engine alone.
 *
 * This is the one place platform error semantics genuinely must cross the
 * boundary. Ingestion is platform-agnostic by construction and never sees an
 * HTTP status or a `Retry-After` header — so without a typed discriminant it
 * either retries a store that needs the merchant to reconnect, forever, or gives
 * up on a transient rate limit. The alternative is ingestion pattern-matching on
 * error message strings, which is platform vocabulary leaking in through the
 * back door.
 */
export const ADAPTER_ERROR_KINDS = [
  /** The merchant must reconnect. Retrying will never succeed. */
  'reauth_required',
  'rate_limited',
  'not_found',
  /** Permanent 4xx: bad request shape, insufficient scope. */
  'invalid',
  /** 5xx, network, timeout. */
  'transient',
  'permanent',
] as const;

export type AdapterErrorKind = (typeof ADAPTER_ERROR_KINDS)[number];

export interface AdapterError extends Error {
  readonly platform: PlatformId;
  readonly kind: AdapterErrorKind;
  readonly retryable: boolean;
  readonly retryAfterMs: number | null;
  readonly httpStatus: number | null;
}

/**
 * Validates EVERY field it narrows to, not a representative sample.
 *
 * This guard runs on values caught as `unknown`, where the interface guarantees
 * nothing — so a partial check hands the compiler a promise the value does not
 * keep. Checking only `kind` and `retryable` was enough to let an error with no
 * `retryAfterMs` through, after which the idiomatic
 * `if (err.retryAfterMs === null) useDefault()` is false and ingestion schedules
 * a retry with `undefined` delay: an immediate, unbounded loop against a
 * platform that is already rate-limiting us.
 */
export function isAdapterError(error: unknown): error is AdapterError {
  if (!(error instanceof Error)) return false;
  const e = error as Partial<AdapterError>;
  return (
    typeof e.platform === 'string' &&
    typeof e.kind === 'string' &&
    (ADAPTER_ERROR_KINDS as readonly string[]).includes(e.kind) &&
    typeof e.retryable === 'boolean' &&
    (e.retryAfterMs === null || typeof e.retryAfterMs === 'number') &&
    (e.httpStatus === null || typeof e.httpStatus === 'number')
  );
}
