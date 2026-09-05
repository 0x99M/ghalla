/**
 * A credential that does not serialize.
 *
 * The commonest way credentials leak is not a deliberate log line — it is
 * `logger.error({ err, creds })`, or an error-reporting breadcrumb serializing a
 * context object that happens to hold a token. `toJSON` and `toString` both
 * return a placeholder, so the accident produces nothing.
 */
export interface Secret {
  readonly reveal: () => string;
  readonly toJSON: () => '[redacted]';
  readonly toString: () => '[redacted]';
}

export type SecretBag = Readonly<Record<string, Secret>>;

export function secret(value: string): Secret {
  return {
    reveal: () => value,
    toJSON: () => '[redacted]',
    toString: () => '[redacted]',
  };
}

export function isSecret(value: unknown): value is Secret {
  return typeof value === 'object' && value !== null && typeof (value as Secret).reveal === 'function';
}
