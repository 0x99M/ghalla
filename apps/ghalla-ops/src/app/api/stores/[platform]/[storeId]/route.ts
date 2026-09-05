import { getRegistry } from '../../../../../lib/platforms';
import { storeDetail } from '../../../../../lib/queries/store-detail';
import { ok, notFound } from '../../../../../lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Uncached: this page is opened while investigating and must show the state right now. */
export async function GET(
  _request: Request,
  context: { params: Promise<{ platform: string; storeId: string }> },
): Promise<Response> {
  const { platform, storeId } = await context.params;
  // NOT decoded again: Next has already decoded the dynamic segment, and a
  // second pass throws URIError on a store id containing a bare '%' and
  // silently rewrites one containing an encoded slash.
  const result = await storeDetail(getRegistry(), platform, storeId, new Date());
  return result.kind === 'found' ? ok(result.detail) : notFound(result.kind);
}
