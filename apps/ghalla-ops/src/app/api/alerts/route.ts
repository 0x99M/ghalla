import { getRegistry } from '../../../lib/platforms';
import { getPortalDb } from '../../../lib/db/portal-db';
import { activeAcks } from '../../../lib/portal/alert-acks';
import { alertFeed } from '../../../lib/queries/alert-feed';
import { ok } from '../../../lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  const now = new Date();
  return ok(await alertFeed(getRegistry(), async () => activeAcks(getPortalDb(), now), now));
}
