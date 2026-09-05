/**
 * What must never reach a log line.
 *
 * The brief forbids customer PII in the database. A log is the same hazard with
 * none of the protections: it is replicated to a platform we do not control,
 * retained on a schedule nobody set deliberately, and readable by anyone with
 * dashboard access. A phone number in a log line is a phone number we stored.
 *
 * Two categories, and they fail differently:
 *
 *   - CREDENTIALS. An access token in a log is a compromised merchant account.
 *     This is the one that ends an integration.
 *   - PII. A customer's name, phone, address or email. This is the one that
 *     ends a company, because it is a regulatory matter rather than a bug.
 *
 * `pino`'s `redact` walks these paths on every object it serializes and
 * replaces the value. Paths are literal — pino does not do arbitrary deep
 * search — so the wildcard forms below matter as much as the exact ones, and a
 * new payload shape needs a new entry here. That is a real maintenance cost and
 * the alternative is worse: an allowlist would drop the diagnostic fields that
 * make a log worth keeping.
 */
export const REDACT_PATHS: readonly string[] = [
  // ── credentials ─────────────────────────────────────────────────────────
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  // Platform webhook signatures. Not secret in themselves, but they are an
  // oracle for the shared secret and there is no reason to keep them.
  'req.headers["x-salla-signature"]',
  'req.headers["x-signature"]',
  '*.accessToken',
  '*.refreshToken',
  '*.clientSecret',
  '*.webhookSecret',
  'accessToken',
  'refreshToken',
  'clientSecret',
  'webhookSecret',
  'password',
  'token',

  // ── customer PII ────────────────────────────────────────────────────────
  // The raw webhook body is the single biggest carrier: it is the platform's
  // full order payload, names and addresses included. It is kept in the
  // database for replay under a retention schedule; it has no business in a
  // log at all.
  'rawPayload',
  'rawBody',
  '*.rawPayload',
  '*.rawBody',
  'req.body',
  '*.customer',
  'customer',
  '*.shippingAddress',
  'shippingAddress',
  '*.billingAddress',
  'billingAddress',
  '*.phone',
  'phone',
  '*.email',
  'email',
  '*.customerName',
  'customerName',
];

/** Replaces the value rather than deleting the key, so a reader can tell a redacted field from an absent one. */
export const REDACT_CENSOR = '[redacted]';

/**
 * Paths whose request logging is suppressed entirely.
 *
 * Railway polls the healthcheck continuously. Logged, it is well over 99% of
 * the volume in a quiet environment — which does not merely cost money, it
 * buries the twenty lines that matter under a hundred thousand that do not. The
 * healthcheck already reports its own state through its status code, which is
 * what the platform reads.
 */
const SILENT_PATHS: readonly string[] = ['/api/v1/health', '/api/v1/ping'];

/**
 * Whether a request should be logged at all.
 *
 * Matches on the path only, ignoring any query string — a healthcheck with a
 * cache-buster appended is still a healthcheck.
 */
export function shouldLogRequest(url: string | undefined): boolean {
  if (url === undefined || url === '') return true;
  // `split('?')[0]` would need a `?? url` for an element that always exists —
  // an unreachable branch. Both sides of this one are real and both are tested.
  const query = url.indexOf('?');
  return !SILENT_PATHS.includes(query === -1 ? url : url.slice(0, query));
}

/**
 * HTTP status to log level.
 *
 * A 4xx is the caller's mistake and a 5xx is ours, and conflating them means
 * either alerting on someone else's malformed request or not alerting on our
 * own failure. A 499-and-below default of `info` keeps the normal path quiet.
 */
export function levelForStatus(status: number | undefined): 'info' | 'warn' | 'error' {
  if (status === undefined) return 'info';
  if (status >= 500) return 'error';
  if (status >= 400) return 'warn';
  return 'info';
}
