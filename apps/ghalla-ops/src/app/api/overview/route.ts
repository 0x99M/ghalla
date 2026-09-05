import { getAggregateCache } from '../../../lib/cache';
import { getRegistry } from '../../../lib/platforms';
import { overview } from '../../../lib/queries/overview';
import { ok } from '../../../lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  const cache = getAggregateCache();
  // `?refresh=1` is the manual bust the design calls for.
  if (new URL(request.url).searchParams.get('refresh') !== null) cache.invalidate('overview');

  const now = new Date();
  return ok(await cache.read('overview', now.getTime(), async () => overview(getRegistry(), now)));
}
