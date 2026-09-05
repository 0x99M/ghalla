import { checkHealth } from '../../../lib/health';
import { getRegistry } from '../../../lib/platforms/index';
import { getPortalDb, pingPortalDb } from '../../../lib/db/portal-db';

/** Reads live state on every call; caching it would defeat the point of asking. */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(): Promise<Response> {
  const report = await checkHealth({
    registry: getRegistry(),
    pingPortal: async () => {
      await pingPortalDb(getPortalDb());
    },
  });

  // 503 only when the PORTAL is broken. A platform being unreachable is a 200
  // with `degraded` — see lib/health.ts for why a health check must not restart
  // this container because somebody else's database is down.
  return Response.json(report, { status: report.status === 'error' ? 503 : 200 });
}
