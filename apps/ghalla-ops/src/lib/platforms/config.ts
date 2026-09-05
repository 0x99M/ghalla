import { isPlatformId } from '@ghalla/contracts';
import type { PlatformId } from '@ghalla/contracts';

/**
 * Which integrations exist, read entirely from the environment.
 *
 * The brief's test for this abstraction is that adding a platform must not
 * require touching query code, and the strongest form of that is a registry
 * with no entries to add either: the platform list IS an environment variable,
 * and every other setting is derived from the slug it contains.
 *
 *   GHALLA_PLATFORMS=salla,zid
 *   DATABASE_URL_SALLA=postgres://ghalla_ops_ro@.../ghalla_salla
 *   ADMIN_API_URL_SALLA=https://...
 *   ADMIN_API_TOKEN_SALLA=...
 *
 * Nothing in this file, and nothing downstream of it, knows what any of those
 * slugs mean.
 */

export interface AdminApiConfig {
  readonly baseUrl: string;
  /** Server-side only. Must never reach a response body, a log line, or a client bundle. */
  readonly token: string;
}

export interface PlatformConfig {
  readonly platform: PlatformId;
  readonly databaseUrl: string;
  /**
   * `null` when the integration exposes no admin API yet.
   *
   * Absence is reported rather than faked. An action route against a platform
   * with no admin API answers "unavailable", which is a different thing from
   * "dispatched and nothing happened" — and only one of those is safe to
   * believe at 03:00.
   */
  readonly adminApi: AdminApiConfig | null;
}

/**
 * What these loaders read, as a plain map.
 *
 * Deliberately NOT `NodeJS.ProcessEnv`: Next augments that interface with a
 * REQUIRED `NODE_ENV`, so every test fixture would have to carry a variable
 * none of this code reads. Configuration parsing should not depend on a
 * framework's ambient types — `process.env` is assignable to this.
 */
export type Env = Readonly<Record<string, string | undefined>>;

export class PlatformConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlatformConfigError';
  }
}

/**
 * Stricter than `PlatformId` allows, and the difference matters.
 *
 * A platform id may contain a hyphen. An environment variable name may not, so
 * the slug has to become `DATABASE_URL_<UPPERCASE>` by some rule — and the
 * obvious rule, hyphen to underscore, makes `my-shop` and `my_shop` collide on
 * one variable. Rather than pick a winner, this refuses the ambiguity.
 */
const ENV_SAFE_SLUG = /^[a-z0-9][a-z0-9_]*$/;

export function envSuffixFor(platform: string): string {
  return platform.toUpperCase();
}

function read(env: Env, name: string): string | null {
  const value = env[name];
  return value === undefined || value.trim() === '' ? null : value.trim();
}

function loadAdminApi(env: Env, platform: string): AdminApiConfig | null {
  const suffix = envSuffixFor(platform);
  const baseUrl = read(env, `ADMIN_API_URL_${suffix}`);
  const token = read(env, `ADMIN_API_TOKEN_${suffix}`);

  if (baseUrl === null && token === null) return null;
  // Half a configuration is refused rather than degraded. A URL with no token
  // would send unauthenticated writes at an integration service, and a token
  // with no URL is a live credential sitting in an environment for no reason.
  if (baseUrl === null || token === null) {
    throw new PlatformConfigError(
      `ADMIN_API_URL_${suffix} and ADMIN_API_TOKEN_${suffix} must be set together; ` +
        `only ${baseUrl === null ? 'the token' : 'the URL'} is present.`,
    );
  }
  return { baseUrl, token };
}

/**
 * Throws rather than degrading, and that is deliberate.
 *
 * A platform listed with no database URL is a deploy-time typo: it will never
 * fix itself, and starting anyway would show that platform as "unreachable" —
 * which is exactly how a real outage looks. Failing here means Railway's health
 * check catches it before the service takes traffic, instead of an operator
 * chasing a database that was never being contacted.
 *
 * A platform that is configured and DOWN is the opposite case, and is handled
 * the opposite way: the portal serves, and the fan-out reports it missing.
 */
export function loadPlatformConfigs(env: Env): readonly PlatformConfig[] {
  const raw = read(env, 'GHALLA_PLATFORMS');
  if (raw === null) {
    throw new PlatformConfigError('GHALLA_PLATFORMS is not set; the portal has nothing to read.');
  }

  const slugs = raw
    .split(',')
    .map((slug) => slug.trim())
    .filter((slug) => slug !== '');
  if (slugs.length === 0) {
    throw new PlatformConfigError('GHALLA_PLATFORMS is empty; the portal has nothing to read.');
  }

  const seen = new Set<string>();
  return slugs.map((slug) => {
    if (!ENV_SAFE_SLUG.test(slug) || !isPlatformId(slug)) {
      throw new PlatformConfigError(
        `"${slug}" is not a usable platform slug. It must match ${String(ENV_SAFE_SLUG)} — ` +
          `a hyphen is allowed in a platform id but not in the environment variable name derived from it.`,
      );
    }
    if (seen.has(slug)) {
      throw new PlatformConfigError(`"${slug}" is listed twice in GHALLA_PLATFORMS.`);
    }
    seen.add(slug);

    const suffix = envSuffixFor(slug);
    const databaseUrl = read(env, `DATABASE_URL_${suffix}`);
    if (databaseUrl === null) {
      throw new PlatformConfigError(
        `"${slug}" is listed in GHALLA_PLATFORMS but DATABASE_URL_${suffix} is not set.`,
      );
    }

    return { platform: slug, databaseUrl, adminApi: loadAdminApi(env, slug) };
  });
}

export interface PortalConfig {
  readonly databaseUrl: string;
}

/**
 * The portal's own database, under its own variable name.
 *
 * Not `DATABASE_URL`: this service holds a connection string for every
 * integration at once, and the one generic name is the one most likely to be
 * pasted with the wrong value. The portal is the only database it may write to,
 * so the variable that points at it says which one it is.
 */
export function loadPortalConfig(env: Env): PortalConfig {
  const databaseUrl = read(env, 'PORTAL_DATABASE_URL');
  if (databaseUrl === null) {
    throw new PlatformConfigError('PORTAL_DATABASE_URL is not set.');
  }
  return { databaseUrl };
}
