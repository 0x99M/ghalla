import { getPortalDb } from '../../../../../lib/db/portal-db';
import { acknowledgeAlert } from '../../../../../lib/portal/ack-action';
import { parseAckBody, parseAlertKey } from '../../../../../lib/api/params';
import { ok, withParsed } from '../../../../../lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  context: { params: Promise<{ key: string }> },
): Promise<Response> {
  const { key } = await context.params;
  return withParsed(parseAlertKey(key), async (alertKey) =>
    withParsed(parseAckBody(await readJson(request)), async (body) =>
      ok(await acknowledgeAlert(getPortalDb(), alertKey, request.headers, body.note ?? null, new Date())),
    ),
  );
}

/** An empty body is an acknowledgement with no note, not a malformed request. */
async function readJson(request: Request): Promise<unknown> {
  try {
    return (await request.json()) as unknown;
  } catch {
    return {};
  }
}
