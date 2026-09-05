import { SESSION_HEADER, sessionFromHeaders } from '../auth/session-header';
import { acknowledge } from './alert-acks';
import type { AckRecord } from './alert-acks';
import type { PortalDatabase } from '../db/portal-db';

/**
 * Acknowledging an alert, with whatever identity this portal can honestly claim.
 *
 * The actor is a SESSION, not a person — one shared access key means "who did
 * this" is not a question the portal can answer, and the column is named for
 * what it holds. Two operators on the same key are still distinguishable by
 * session, which is better than nothing and is exactly as much as is true.
 */
export async function acknowledgeAlert(
  db: PortalDatabase,
  alertKey: string,
  headers: Headers,
  note: string | null,
  now: Date,
): Promise<AckRecord> {
  // The middleware has already verified the session and stamped it. See
  // `session-header.ts` for why this value cannot be supplied by a client.
  const actorSession = sessionFromHeaders(headers) ?? 'unattributed';
  return acknowledge(db, alertKey, actorSession, note, now);
}

export { SESSION_HEADER };
