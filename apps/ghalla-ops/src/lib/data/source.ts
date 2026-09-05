import type { Env } from '../platforms/config';

/**
 * Fixtures or the real integration databases, decided by ONE variable.
 *
 *   OPS_DATA_SOURCE=fixtures
 *
 * Every screen reads through `lib/data`, never from `lib/queries` or from a
 * fixture module directly, so moving the console onto live data is this
 * variable and nothing else.
 *
 * LIVE IS THE DEFAULT, and the asymmetry is deliberate: an unset variable in
 * production must produce an error about an unreachable database, never a page
 * of invented figures. A console that silently shows fabricated numbers during
 * an incident is worse than a console that is down, because somebody acts on
 * it.
 */
export const DATA_SOURCE_VAR = 'OPS_DATA_SOURCE';

export type DataSource = 'live' | 'fixtures';

export function dataSource(env: Env): DataSource {
  return env[DATA_SOURCE_VAR] === 'fixtures' ? 'fixtures' : 'live';
}

export function usingFixtures(env: Env): boolean {
  return dataSource(env) === 'fixtures';
}
