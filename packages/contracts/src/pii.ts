/**
 * "No customer PII in the database", taken literally.
 *
 * Not a lint rule and not a policy document: a compile-time deny-list over the
 * *keys* of every canonical type. A field that cannot be declared cannot be
 * mapped, cannot be persisted, and cannot leak. The compile error names the
 * offending field.
 */
export type ForbiddenKey =
  | 'name'
  | 'firstName'
  | 'lastName'
  | 'fullName'
  | 'customerName'
  | 'phone'
  | 'mobile'
  | 'email'
  | 'address'
  | 'address1'
  | 'address2'
  | 'street'
  | 'postalCode'
  | 'district'
  | 'nationalId'
  | 'birthday'
  | 'gender'
  | 'ip'
  | 'ipAddress'
  | 'userAgent'
  | 'latitude'
  | 'longitude'
  | 'geoCoordinates'
  /**
   * A waybill number resolves to a delivery address on the carrier's public
   * tracking site, so it is personal data by reference. The consequence is
   * deliberate and worth stating: a future carrier-invoice import must reconcile
   * on `platformShipmentId`, not on the tracking number.
   */
  | 'trackingNumber';

export type AssertNoPii<T> = [Extract<keyof T, ForbiddenKey>] extends [never]
  ? true
  : { readonly PII_FIELD: Extract<keyof T, ForbiddenKey> };

/** Fails to compile unless `T` is exactly `true`. */
export type Assert<T extends true> = T;
