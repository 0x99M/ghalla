import { describe, expect, it } from 'vitest';
import type { Env } from '../src/lib/platforms/config';
import {
  PlatformConfigError,
  envSuffixFor,
  loadPlatformConfigs,
  loadPortalConfig,
} from '../src/lib/platforms/config';

/**
 * Configuration is where a portal that reads every merchant's data gets pointed
 * at the wrong database, so it is worth being strict about — and every rule
 * here exists because the failure it prevents is silent.
 */

const BASE = {
  GHALLA_PLATFORMS: 'demo,other',
  DATABASE_URL_DEMO: 'postgres://ro@demo/db',
  DATABASE_URL_OTHER: 'postgres://ro@other/db',
} satisfies Env;

describe('loadPlatformConfigs', () => {
  it('registers a platform from environment variables alone', () => {
    const configs = loadPlatformConfigs(BASE);
    expect(configs.map((c) => c.platform)).toEqual(['demo', 'other']);
    expect(configs[0]?.databaseUrl).toBe('postgres://ro@demo/db');
  });

  it('adds a platform with no code change — the test the abstraction has to pass', () => {
    const before = loadPlatformConfigs(BASE).length;
    const after = loadPlatformConfigs({
      ...BASE,
      GHALLA_PLATFORMS: 'demo,other,third',
      DATABASE_URL_THIRD: 'postgres://ro@third/db',
    });
    expect(after).toHaveLength(before + 1);
    expect(after.at(-1)?.platform).toBe('third');
  });

  it('tolerates whitespace and empty entries in the list', () => {
    expect(loadPlatformConfigs({ ...BASE, GHALLA_PLATFORMS: ' demo , , other ' })).toHaveLength(2);
  });

  it('refuses a platform listed with no database URL, rather than starting half-blind', () => {
    // Deterministic and permanent: it will never fix itself, and starting anyway
    // would make a typo look exactly like an outage.
    expect(() => loadPlatformConfigs({ GHALLA_PLATFORMS: 'demo' })).toThrow(PlatformConfigError);
    expect(() => loadPlatformConfigs({ GHALLA_PLATFORMS: 'demo' })).toThrow(/DATABASE_URL_DEMO/);
  });

  it('treats a blank value as absent', () => {
    expect(() => loadPlatformConfigs({ GHALLA_PLATFORMS: 'demo', DATABASE_URL_DEMO: '   ' })).toThrow(
      /DATABASE_URL_DEMO/,
    );
  });

  it('refuses an empty or missing platform list', () => {
    expect(() => loadPlatformConfigs({})).toThrow(/GHALLA_PLATFORMS is not set/);
    expect(() => loadPlatformConfigs({ GHALLA_PLATFORMS: ' , ' })).toThrow(/nothing to read/);
  });

  it('refuses a duplicate, which would open two pools and count every store twice', () => {
    expect(() =>
      loadPlatformConfigs({ ...BASE, GHALLA_PLATFORMS: 'demo,demo' }),
    ).toThrow(/listed twice/);
  });

  it('refuses a hyphenated slug, because two of them would collide on one variable', () => {
    // `my-shop` and `my_shop` both become DATABASE_URL_MY_SHOP. A platform id
    // may contain a hyphen; the variable name derived from it may not, and
    // picking a winner silently is worse than refusing.
    expect(() =>
      loadPlatformConfigs({ GHALLA_PLATFORMS: 'my-shop', 'DATABASE_URL_MY-SHOP': 'postgres://x' }),
    ).toThrow(/usable platform slug/);
  });

  it('refuses a slug the domain would reject as an id', () => {
    expect(() => loadPlatformConfigs({ GHALLA_PLATFORMS: '_leading' })).toThrow(/usable platform slug/);
  });

  it('reports no admin API when neither variable is set', () => {
    expect(loadPlatformConfigs(BASE)[0]?.adminApi).toBeNull();
  });

  it('reads an admin API when both variables are set', () => {
    const configs = loadPlatformConfigs({
      ...BASE,
      ADMIN_API_URL_DEMO: 'https://demo.example/admin',
      ADMIN_API_TOKEN_DEMO: 'secret',
    });
    expect(configs[0]?.adminApi).toEqual({ baseUrl: 'https://demo.example/admin', token: 'secret' });
  });

  it('refuses half an admin API configuration in either direction', () => {
    // A URL with no token sends unauthenticated writes at an integration
    // service; a token with no URL is a live credential in an environment for
    // no reason. Neither should start.
    expect(() => loadPlatformConfigs({ ...BASE, ADMIN_API_URL_DEMO: 'https://x' })).toThrow(
      /only the URL is present/,
    );
    expect(() => loadPlatformConfigs({ ...BASE, ADMIN_API_TOKEN_DEMO: 'x' })).toThrow(
      /only the token is present/,
    );
  });
});

describe('envSuffixFor', () => {
  it('upper-cases the slug', () => {
    expect(envSuffixFor('demo')).toBe('DEMO');
  });
});

describe('loadPortalConfig', () => {
  it('reads the portal database under its own name', () => {
    expect(loadPortalConfig({ PORTAL_DATABASE_URL: 'postgres://portal' })).toEqual({
      databaseUrl: 'postgres://portal',
    });
  });

  it('refuses to fall back to DATABASE_URL', () => {
    // The one generic name is the one most likely to hold an integration's
    // connection string, and that is a database this service may not write to.
    expect(() => loadPortalConfig({ DATABASE_URL: 'postgres://an-integration' })).toThrow(
      /PORTAL_DATABASE_URL/,
    );
  });
});
