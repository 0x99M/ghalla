import { desc, eq, gte } from 'drizzle-orm';
import { toInstant } from '@ghalla/contracts';
import type { Instant } from '@ghalla/contracts';
import { alertAck } from '../db/portal-schema';
import type { PortalDatabase } from '../db/portal-db';
import { ACK_TTL_MS } from '../queries/alerts';

/**
 * Alert acknowledgements — the portal's OWN table, and one of the two things it
 * is allowed to write.
 *
 * Reads are filtered to acknowledgements that have not expired, in SQL rather
 * than in the caller: an operator's portal accumulates one row per alert they
 * have ever seen, and loading all of them to throw most away is a scan that
 * grows forever for no reason.
 */

export async function activeAcks(
  db: PortalDatabase,
  now: Date,
): Promise<ReadonlyMap<string, Instant>> {
  const since = new Date(now.getTime() - ACK_TTL_MS);
  const rows = await db
    .select({ alertKey: alertAck.alertKey, acknowledgedAt: alertAck.acknowledgedAt })
    .from(alertAck)
    .where(gte(alertAck.acknowledgedAt, since));

  return new Map(rows.map((row) => [row.alertKey, toInstant(row.acknowledgedAt.toISOString())]));
}

export interface AckRecord {
  readonly alertKey: string;
  readonly acknowledgedAt: Instant;
  readonly note: string | null;
}

/**
 * Acknowledging the same alert twice REPLACES the first.
 *
 * The alternative — ignoring the second — means an alert acknowledged
 * yesterday and acknowledged again today expires on yesterday's clock, and
 * resurfaces while the operator is still working on it.
 */
export async function acknowledge(
  db: PortalDatabase,
  alertKey: string,
  actorSession: string,
  note: string | null,
  now: Date,
): Promise<AckRecord> {
  const values = { alertKey, acknowledgedAt: now, actorSession, note };
  await db
    .insert(alertAck)
    .values(values)
    .onConflictDoUpdate({
      target: alertAck.alertKey,
      set: { acknowledgedAt: now, actorSession, note },
    });

  return { alertKey, acknowledgedAt: toInstant(now.toISOString()), note };
}

export async function recentAcks(db: PortalDatabase, limit: number): Promise<readonly AckRecord[]> {
  const rows = await db
    .select({
      alertKey: alertAck.alertKey,
      acknowledgedAt: alertAck.acknowledgedAt,
      note: alertAck.note,
    })
    .from(alertAck)
    .orderBy(desc(alertAck.acknowledgedAt))
    .limit(limit);

  return rows.map((row) => ({
    alertKey: row.alertKey,
    acknowledgedAt: toInstant(row.acknowledgedAt.toISOString()),
    note: row.note,
  }));
}

export async function forget(db: PortalDatabase, alertKey: string): Promise<void> {
  await db.delete(alertAck).where(eq(alertAck.alertKey, alertKey));
}
