/**
 * @ghalla/persistence — the Drizzle schema, its migrations, and the repositories
 * over them.
 *
 * ONE schema, deployed per platform to its own database. Each integration is its
 * own service with its own Postgres; they share this code, not infrastructure.
 */

export * as schema from './db/schema.js';
export type { Database, PoolConfig } from './db/pool.js';
export { createDb, createPool, resolveSsl } from './db/pool.js';
export { defaultMigrationsFolder, runMigrations } from './db/migrate.js';

export {
  MONEY_PRECISION,
  MONEY_SCALE,
  UnsupportedCurrencyError,
  assertStorableCurrency,
  integerToMinor,
  minorToNumeric,
  minorToNumericOrNull,
  numericToMinor,
  numericToMinorOrNull,
} from './db/money.js';

export {
  toBpsFromColumn,
  toBpsFromColumnOrNull,
  toCalcVersionFromColumn,
  toDateFromInstant,
  toDateFromInstantOrNull,
  toEnumFromColumn,
  toIdFromColumn,
  toIdFromColumnOrNull,
  toInstantFromDate,
  toInstantFromDateOrNull,
  toLocalDateFromColumn,
} from './db/codec.js';

export type { CostEntry, ProductKeyRef } from './repositories/cost-history.repository.js';
export { CostHistoryRepository } from './repositories/cost-history.repository.js';
export { OrderProfitRepository } from './repositories/order-profit.repository.js';

export type {
  EnqueueOutcome,
  NewWebhookEvent,
  RetryPolicy,
  WebhookEventRecord,
} from './repositories/webhook-event.repository.js';
export {
  DEFAULT_RETRY_POLICY,
  WebhookEventRepository,
  backoffMs,
} from './repositories/webhook-event.repository.js';
