import { describe, expect, it } from 'vitest';
import { ConfigError, loadEnv } from '../src/config/env.js';

const base = { DATABASE_URL: 'postgres://user:pass@db:5432/ghalla' };

describe('loadEnv', () => {
  it('reads a well-formed environment', () => {
    const env = loadEnv({
      ...base,
      NODE_ENV: 'staging',
      PORT: '8080',
      PGSSLMODE: 'require',
      DATABASE_POOL_MAX: '5',
      RAILWAY_ENVIRONMENT_NAME: 'staging',
      RAILWAY_GIT_COMMIT_SHA: 'abc1234def',
    });
    expect(env).toStrictEqual({
      nodeEnv: 'staging',
      port: 8080,
      databaseUrl: base.DATABASE_URL,
      databaseSslMode: 'require',
      databasePoolMax: 5,
      railwayEnvironment: 'staging',
      logLevel: undefined,
      gitSha: 'abc1234def',
    });
  });

  it('refuses to start without a database', () => {
    // Better here than on the first request that needs it: on Railway that
    // would be a healthcheck that passes, a deploy that goes green, and a
    // failure the merchant finds before we do.
    expect(() => loadEnv({})).toThrow(ConfigError);
    expect(() => loadEnv({ DATABASE_URL: '' })).toThrow(ConfigError);
  });

  it('defaults the port but honours the one the platform assigns', () => {
    // Railway assigns PORT. Hard-coding one produces a service that builds,
    // deploys, and fails its healthcheck with nothing in the log to say why.
    expect(loadEnv(base).port).toBe(3000);
    expect(loadEnv({ ...base, PORT: '' }).port).toBe(3000);
    expect(loadEnv({ ...base, PORT: '4567' }).port).toBe(4567);
  });

  it('rejects a port that is not a positive integer', () => {
    for (const port of ['0', '-1', '80.5', 'eighty', ' ']) {
      expect(() => loadEnv({ ...base, PORT: port })).toThrow(ConfigError);
    }
  });

  it('rejects an unknown NODE_ENV rather than guessing what was meant', () => {
    expect(() => loadEnv({ ...base, NODE_ENV: 'prod' })).toThrow(ConfigError);
    expect(loadEnv({ ...base, NODE_ENV: 'production' }).nodeEnv).toBe('production');
  });

  it('defaults NODE_ENV to development, so an unset one is not production', () => {
    expect(loadEnv(base).nodeEnv).toBe('development');
  });

  it('leaves the optional platform values undefined rather than inventing them', () => {
    const env = loadEnv(base);
    expect(env.railwayEnvironment).toBeUndefined();
    expect(env.gitSha).toBeUndefined();
    expect(env.databaseSslMode).toBeUndefined();
    expect(env.databasePoolMax).toBe(10);
  });

  it('rejects a pool size that is not a positive integer', () => {
    expect(() => loadEnv({ ...base, DATABASE_POOL_MAX: '0' })).toThrow(ConfigError);
    expect(() => loadEnv({ ...base, DATABASE_POOL_MAX: '-3' })).toThrow(ConfigError);
  });
});
