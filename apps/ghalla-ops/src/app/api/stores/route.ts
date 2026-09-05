import { getRegistry } from '../../../lib/platforms';
import { parseStoreQuery } from '../../../lib/api/params';
import { storeList } from '../../../lib/queries/store-list';
import { ok, withParsed } from '../../../lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  return withParsed(parseStoreQuery(new URL(request.url).searchParams), async (query) =>
    ok(await storeList(getRegistry(), query, new Date())),
  );
}
