import type { Instant } from '@ghalla/contracts';
import type { SecretBag } from './secret.js';

export interface WebhookDelivery {
  /** The path the delivery arrived on. Some platforms send a bare resource with no event-name
   *  envelope, and the only way to recover the event type is the route it was registered against. */
  readonly path: string;
  /**
   * Lowercase keys; repeated headers joined by the normalizer.
   *
   * Not DOM `Headers` and not Node's `IncomingHttpHeaders`. The pure layer
   * compiles with `"lib": ["ES2024"], "types": []`, and importing either would
   * force the exact compiler setting that makes `fetch`, `process` and `Buffer`
   * typecheck inside a package that must not have them.
   */
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  /**
   * EXACT received bytes.
   *
   * Never a string. An HMAC must run over what actually arrived, and a UTF-8
   * round trip through `JSON.parse`/`JSON.stringify` changes escaping — a live
   * risk, not a theoretical one, when store and product names are in Arabic.
   * This type makes the common `hash(JSON.stringify(req.body))` mistake a
   * compile error. The HTTP layer must capture the raw buffer BEFORE any body
   * parser runs.
   */
  readonly rawBody: Uint8Array;
  /** Injected, so verification is pure and its replay window is testable. */
  readonly receivedAt: Instant;
}

/**
 * Not a boolean.
 *
 * A boolean makes "wrong secret" and "clock skew" indistinguishable in
 * production on day one, and it cannot carry the tenant key — which matters,
 * because the store identifier lives in the signed envelope on one platform and
 * in an unsigned body on another.
 */
export type WebhookVerification =
  | { readonly ok: true; readonly platformStoreId: string }
  | {
      readonly ok: false;
      readonly reason:
        | 'missing_signature'
        | 'bad_signature'
        | 'stale_timestamp'
        | 'malformed_body'
        | 'unsupported_strategy';
    };

/**
 * The two shapes an install can take, without ever putting credentials into a
 * `PlatformEvent`: either the app exchanges an authorization code, or the
 * platform delivers the credentials by webhook and the adapter unwraps them.
 */
export type AuthGrant =
  | { readonly kind: 'code'; readonly code: string; readonly redirectUri: string }
  | { readonly kind: 'delivery'; readonly delivery: WebhookDelivery };

export type WebhookSecret = SecretBag;

/** Lowercases keys and joins repeats, so an adapter's HMAC never depends on a server's header casing. */
export function normalizeHeaders(
  source: Iterable<readonly [string, string]> | Readonly<Record<string, string | readonly string[] | undefined>>,
): WebhookDelivery['headers'] {
  const out: Record<string, string | readonly string[] | undefined> = {};
  const entries: Iterable<readonly [string, string | readonly string[] | undefined]> =
    Symbol.iterator in Object(source)
      ? (source as Iterable<readonly [string, string]>)
      : Object.entries(source as Readonly<Record<string, string | readonly string[] | undefined>>);

  for (const [key, value] of entries) {
    const lower = key.toLowerCase();
    const existing = out[lower];
    if (existing === undefined) {
      out[lower] = value;
    } else {
      const merge = (v: string | readonly string[] | undefined): readonly string[] =>
        v === undefined ? [] : typeof v === 'string' ? [v] : v;
      out[lower] = [...merge(existing), ...merge(value)];
    }
  }
  return out;
}
