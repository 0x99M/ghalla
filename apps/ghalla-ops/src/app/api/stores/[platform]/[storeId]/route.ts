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
  const result = await storeDetail(getRegistry(), platform, decodeURIComponent(storeId), new Date());
  return result.kind === 'found' ? ok(result.detail) : notFound(result.kind);
}
