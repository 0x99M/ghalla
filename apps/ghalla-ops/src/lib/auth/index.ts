import { loadAuthConfig } from './access-key';
import { createLoginLimiter } from './rate-limit';
import type { AuthConfig } from './access-key';
import type { LoginLimiterDeps } from './rate-limit';

/**
 * `process.env` is read as a GLOBAL, with no `import … from 'node:process'`.
 *
 * This module is in the middleware's import graph, and middleware runs on the
 * edge runtime where that specifier does not resolve — the build fails on it.
 * The global is what Next provides in both runtimes.
 */

/**
 * Auth's composition root, held on `globalThis` for the same reason the
 * registry is: Next re-evaluates modules on hot reload, and a module-level
 * limiter would forget every failure on each edit.
 */

const AUTH_KEY = Symbol.for('ghalla.ops.auth');
const LIMITER_KEY = Symbol.for('ghalla.ops.loginLimiter');

interface Holder {
  [AUTH_KEY]?: AuthConfig;
  [LIMITER_KEY]?: LoginLimiterDeps;
}

export function getAuthConfig(): AuthConfig {
  const holder = globalThis as Holder;
  // Not cached on failure: a missing key must keep throwing rather than being
  // remembered as "already checked".
  holder[AUTH_KEY] ??= loadAuthConfig(process.env);
  return holder[AUTH_KEY];
}

export function getLoginLimiter(): LoginLimiterDeps {
  const holder = globalThis as Holder;
  holder[LIMITER_KEY] ??= createLoginLimiter();
  return holder[LIMITER_KEY];
}
