import type { Brand } from './brand.js';

/**
 * A typed identifier. `Id<'order'>` and `Id<'store'>` are both strings at
 * runtime and mutually unassignable at compile time, so an argument-order slip
 * in a five-parameter repository call is a build error rather than a silent
 * cross-tenant read.
 */
export type Id<T extends string> = Brand<string, { readonly entity: T }>;

export type StoreId = Id<'store'>;
export type OrderId = Id<'order'>;
export type OrderItemId = Id<'orderItem'>;
export type ShipmentId = Id<'shipment'>;
export type ReversalId = Id<'reversal'>;
export type CostHistoryId = Id<'costHistory'>;
export type FeeRuleSetId = Id<'feeRuleSet'>;

/**
 * Which platform an adapter speaks for — an opaque, adapter-supplied slug.
 *
 * Deliberately NOT a union of platform names. A union would put platform
 * vocabulary in the shared layer, which is the one thing this architecture
 * exists to prevent, and would make every new integration a change to the
 * package every other package depends on.
 */
export type PlatformId = Brand<string, 'PlatformId'>;

/**
 * A customer, reduced to something that cannot identify anyone.
 *
 * `HMAC-SHA256(per-store salt, platform customer id)`, hex. Exists only so
 * repeat purchases can be counted. The salt is per-store and held outside the
 * database: platform customer ids are small sequential integers, so a global or
 * absent salt is brute-forceable end to end from a database dump in seconds.
 */
export type CustomerRef = Brand<string, 'CustomerRef'>;

/** Monotonic. Bumped whenever the engine's arithmetic changes. */
export type CalcVersion = Brand<number, 'CalcVersion'>;

const SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export class MalformedIdError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MalformedIdError';
  }
}

function requireNonEmpty(part: string, label: string): string {
  if (part.length === 0 || part.includes(':') || part.includes('#')) {
    throw new MalformedIdError(
      `${label} must be non-empty and free of ':' and '#'; received ${JSON.stringify(part)}. ` +
        `Those characters are the identifier separators, so allowing them would let two different ` +
        `platform entities collide onto one Ghalla id.`,
    );
  }
  return part;
}

export function toStoreId(platform: PlatformId, platformStoreId: string): StoreId {
  return `${platform}:${requireNonEmpty(platformStoreId, 'platformStoreId')}` as StoreId;
}

/**
 * Identifiers are DERIVED, never minted.
 *
 * Webhook delivery is at-least-once and backfill overlaps live ingestion, so the
 * same order arrives many times. A database sequence or a random UUID would
 * produce a different id on each arrival and the largest cost lines in the
 * system — shipments — would be counted twice. Deriving the id from the
 * platform's own identity makes replay idempotent by construction, and lets the
 * pure engine be called before anything has touched a database.
 */
export function toOrderId(storeId: StoreId, platformOrderId: string): OrderId {
  return `${storeId}:${requireNonEmpty(platformOrderId, 'platformOrderId')}` as OrderId;
}

export function toOrderItemId(orderId: OrderId, platformLineId: string): OrderItemId {
  return `${orderId}#${requireNonEmpty(platformLineId, 'platformLineId')}` as OrderItemId;
}

export function toShipmentId(storeId: StoreId, platformShipmentId: string): ShipmentId {
  return `${storeId}:${requireNonEmpty(platformShipmentId, 'platformShipmentId')}` as ShipmentId;
}

export function toReversalId(orderId: OrderId, platformReversalId: string): ReversalId {
  return `${orderId}#rev:${requireNonEmpty(platformReversalId, 'platformReversalId')}` as ReversalId;
}

/**
 * Rehydrates a typed id from a string that was already minted by one of the
 * derivations above — reading a row back out of the database, or validating a
 * payload whose ids this system produced.
 *
 * This is the ONLY sanctioned way to obtain an `Id` without deriving it, and it
 * is centralized here so the cast exists in exactly one place instead of being
 * sprinkled through persistence and validation.
 */
export function idFromString<T extends string>(raw: string): Id<T> {
  if (raw.length === 0) {
    throw new MalformedIdError('An identifier may not be empty.');
  }
  return raw as Id<T>;
}

const HEX_256 = /^[0-9a-f]{64}$/;

export function toCustomerRef(hex: string): CustomerRef {
  if (!HEX_256.test(hex)) {
    throw new MalformedIdError(
      `A customer reference must be a 64-character lowercase hex HMAC-SHA256 digest. ` +
        `Anything else risks being reversible, which is the one property it exists to lack.`,
    );
  }
  return hex as CustomerRef;
}

export function isCustomerRef(hex: string): hex is CustomerRef {
  return HEX_256.test(hex);
}

export function toPlatformId(slug: string): PlatformId {
  if (!SLUG.test(slug)) {
    throw new MalformedIdError(`Platform id must match ${String(SLUG)}; received ${JSON.stringify(slug)}.`);
  }
  return slug as PlatformId;
}

export function isPlatformId(slug: string): slug is PlatformId {
  return SLUG.test(slug);
}

export function toCalcVersion(version: number): CalcVersion {
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new MalformedIdError(`calcVersion must be a positive integer; received ${String(version)}.`);
  }
  return version as CalcVersion;
}
