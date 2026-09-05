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
export type AdapterErrorKind =
  /** The merchant must reconnect. Retrying will never succeed. */
  | 'reauth_required'
  | 'rate_limited'
  | 'not_found'
  /** Permanent 4xx: bad request shape, insufficient scope. */
  | 'invalid'
  /** 5xx, network, timeout. */
  | 'transient'
  | 'permanent';

export interface AdapterError extends Error {
  readonly platform: PlatformId;
  readonly kind: AdapterErrorKind;
  readonly retryable: boolean;
  readonly retryAfterMs: number | null;
  readonly httpStatus: number | null;
}

export function isAdapterError(error: unknown): error is AdapterError {
  return (
    error instanceof Error &&
    typeof (error as AdapterError).kind === 'string' &&
    typeof (error as AdapterError).retryable === 'boolean'
  );
}
