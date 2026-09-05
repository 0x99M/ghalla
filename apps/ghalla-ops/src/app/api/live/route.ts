import { getPortalDb, pingPortalDb } from '../../../lib/db/portal-db';
import { liveness } from '../../../lib/health';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Liveness, and the ONLY unauthenticated endpoint that touches infrastructure.
 *
 * Railway calls it, so it cannot require a session. It answers with a status
 * word and a timestamp and nothing else — no platform names, no connection
 * errors, no schema detail. The version an operator wants is in the overview,
 * behind the key.
 *
 * A platform being unreachable does NOT fail it. The brief requires the portal
 * to serve with an integration database down, and a health check that restarts
 * this container because somebody else's database is down turns their outage
 * into ours.
 */
export async function GET(): Promise<Response> {
  const report = await liveness(async () => {
    await pingPortalDb(getPortalDb());
  });
  return Response.json(report, { status: report.status === 'ok' ? 200 : 503 });
}
