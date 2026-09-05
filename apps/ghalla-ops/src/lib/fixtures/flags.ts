import { RAIL_STATES } from './rail';
import type { RailState } from './rail';

/**
 * The handoff's prototype flags, carried in the URL.
 *
 * `?alertsClear=1`, `?zeroStores=1`, `?railState=loading|failed`.
 *
 * The URL rather than environment variables so every edge state is a link
 * somebody can open, screenshot and send — which is the whole job of these
 * flags during visual QA. They are read ONLY when the console is on fixtures;
 * on live data they are ignored entirely, so a stray query parameter can never
 * blank a real operator's store list.
 */

export interface FixtureFlags {
  /** State 1: the good, common case — nothing wrong anywhere. */
  readonly alertsClear: boolean;
  /** State 2: first week after launch, before the first install. */
  readonly zeroStores: boolean;
  /** States 4 and 5: a section still loading, or a section that failed. */
  readonly railState: RailState;
}

export const NO_FLAGS: FixtureFlags = { alertsClear: false, zeroStores: false, railState: 'normal' };

/** `1` and `true` both mean on. Anything else, including absent, means off. */
function isOn(value: string | undefined): boolean {
  return value === '1' || value === 'true';
}

export type RawParams = Readonly<Record<string, string | readonly string[] | undefined>>;

function first(params: RawParams, key: string): string | undefined {
  const value = params[key];
  return Array.isArray(value) ? value[0] : (value as string | undefined);
}

export function parseFixtureFlags(params: RawParams, enabled: boolean): FixtureFlags {
  if (!enabled) return NO_FLAGS;
  const rail = first(params, 'railState');
  return {
    alertsClear: isOn(first(params, 'alertsClear')),
    zeroStores: isOn(first(params, 'zeroStores')),
    railState: (RAIL_STATES as readonly string[]).includes(rail ?? '') ? (rail as RailState) : 'normal',
  };
}
