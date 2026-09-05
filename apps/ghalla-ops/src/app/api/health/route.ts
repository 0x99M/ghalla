import { getRegistry } from '../../../lib/platforms';
import { parseRange } from '../../../lib/api/params';
import { ingestionReport } from '../../../lib/queries/ingestion-report';
import { ok, withParsed } from '../../../lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Ingestion health over a range. Liveness is `/api/live`, which is a different question. */
export async function GET(request: Request): Promise<Response> {
  return withParsed(parseRange(new URL(request.url).searchParams), async (range) =>
    ok(await ingestionReport(getRegistry(), range, new Date())),
  );
}
