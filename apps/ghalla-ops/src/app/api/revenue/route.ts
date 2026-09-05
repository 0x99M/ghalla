import { getAggregateCache } from '../../../lib/cache';
import { getRegistry } from '../../../lib/platforms';
import { parseRange } from '../../../lib/api/params';
import { revenue } from '../../../lib/queries/revenue';
import { ok, withParsed } from '../../../lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const cache = getAggregateCache();
  if (url.searchParams.get('refresh') !== null) cache.clear();

  return withParsed(parseRange(url.searchParams), async (range) => {
    const now = new Date();
    return ok(
      await cache.read(`revenue:${range}`, now.getTime(), async () =>
        revenue(getRegistry(), range, now),
      ),
    );
  });
}
