/**
 * The ingestion boundary — published only at `@ghalla/contracts/ingest`.
 *
 * `packages/core` and `packages/persistence` are forbidden from importing this
 * specifier, by the ESLint boundary rule AND by dependency-cruiser.
 *
 * The reason is not tidiness. "Canonical types carry `raw` only at the ingestion
 * boundary" is a convention that `{ ...canonical, raw }` defeats in a single
 * spread — and the raw payload is precisely where the forbidden customer data
 * lives, since platform order payloads carry names, phone numbers, email
 * addresses and IP addresses inline. Moving `raw` outside the canonical type
 * makes `Ingested<T>` non-assignable to `T`, which is enforcement rather than
 * discipline.
 */
import type { Brand } from './brand.js';
import type { Instant } from './time.js';

/** Exact received bytes. Never a string: a UTF-8 round trip changes escaping, and
 *  signature verification must run over what actually arrived. */
export type RawPayload = Brand<Uint8Array, 'RawPayload'>;

export interface Ingested<T> {
  readonly canonical: T;
  /** Adapter-local diagnostics only. Never persisted; never logged unredacted. */
  readonly raw: RawPayload;
  readonly fetchedAt: Instant;
  readonly adapterVersion: string;
}

export function toRawPayload(bytes: Uint8Array): RawPayload {
  return bytes as RawPayload;
}
