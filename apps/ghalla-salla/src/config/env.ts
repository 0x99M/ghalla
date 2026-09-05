/**
 * Environment, validated once at boot.
 *
 * A missing DATABASE_URL should stop the process on the first line of `main`,
 * not on the first request that happens to touch the database — which on
 * Railway means a healthcheck that passes, a deploy that goes green, and a
 * failure the merchant finds before we do.
 */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export interface Env {
  readonly nodeEnv: 'development' | 'staging' | 'production' | 'test';
  readonly port: number;
  readonly databaseUrl: string;
  readonly databaseSslMode: string | undefined;
  readonly databasePoolMax: number;
  /** Validated by the logger rather than here: a typo must not stop the process booting. */
  readonly logLevel: string | undefined;
  /** Railway sets this. Useful in a log line when two environments look alike. */
  readonly railwayEnvironment: string | undefined;
  readonly gitSha: string | undefined;
}

function required(source: NodeJS.ProcessEnv, key: string): string {
  const value = source[key];
  if (value === undefined || value === '') {
    throw new ConfigError(`${key} is not set. The service cannot start without it.`);
  }
  return value;
}

function integer(source: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = source[key];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new ConfigError(`${key} must be a positive integer; received ${JSON.stringify(raw)}.`);
  }
  return value;
}

const ENVIRONMENTS = ['development', 'staging', 'production', 'test'] as const;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const nodeEnv = source['NODE_ENV'] ?? 'development';
  if (!(ENVIRONMENTS as readonly string[]).includes(nodeEnv)) {
    throw new ConfigError(`NODE_ENV must be one of ${ENVIRONMENTS.join(', ')}; received ${JSON.stringify(nodeEnv)}.`);
  }

  return {
    nodeEnv: nodeEnv as Env['nodeEnv'],
    // Railway assigns the port; a hard-coded one produces a service that builds,
    // deploys, and fails its healthcheck for no visible reason.
    port: integer(source, 'PORT', 3000),
    databaseUrl: required(source, 'DATABASE_URL'),
    databaseSslMode: source['PGSSLMODE'],
    databasePoolMax: integer(source, 'DATABASE_POOL_MAX', 10),
    logLevel: source['LOG_LEVEL'],
    railwayEnvironment: source['RAILWAY_ENVIRONMENT_NAME'],
    gitSha: source['RAILWAY_GIT_COMMIT_SHA'],
  };
}
