import { getStoreList } from '../../../lib/data';
import { parseStoreQuery } from '../../../lib/api/params';
import { ok, withParsed } from '../../../lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Through `lib/data` rather than the registry directly, unlike its siblings.
 *
 * The "Jump to store" dialog reads this route from the browser, so it is the
 * one API route a SCREEN depends on. If it bypassed the fixture switch, a
 * console running on fixtures would show fixture rows in the table and live
 * rows — or a connection error — in the dialog beside it. In live mode the
 * call is the same `storeList` over the same registry; the contract of the
 * route is unchanged.
 */
export async function GET(request: Request): Promise<Response> {
  return withParsed(parseStoreQuery(new URL(request.url).searchParams), async (query) =>
    ok(await getStoreList(query)),
  );
}
