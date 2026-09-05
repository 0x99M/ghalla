import { getAggregateCache } from '../../../lib/cache';
import { ok } from '../../../lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * What the topbar's refresh button calls.
 *
 * POST rather than GET because it has an effect, and clearing the whole cache
 * rather than one key because the operator pressing it has just done something
 * and wants THIS SCREEN to be true — and a screen is several reports. Clearing
 * one key would leave a sidebar badge disagreeing with the list beside it,
 * which is the failure the refresh was pressed to resolve.
 */
export async function POST(): Promise<Response> {
  getAggregateCache().clear();
  return ok({ cleared: true });
}
