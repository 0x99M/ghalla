/**
 * What one section of a screen is doing, independently of its neighbours.
 *
 * `loading` and `failed` are per SECTION and never per page. The brief is
 * explicit that one unreachable platform database must degrade its own section
 * and nothing else, and that is only demonstrable if a section can be in a
 * different state from the card beside it.
 */
export const RAIL_STATES = ['normal', 'loading', 'failed'] as const;
export type RailState = (typeof RAIL_STATES)[number];

/** The error a failed section shows. Real shape, from the driver, not a slogan. */
export const RAIL_FAILURE = 'connect ECONNREFUSED 10.4.2.19:5432';
