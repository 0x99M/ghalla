import { and, asc, eq, inArray, lt, lte, sql } from 'drizzle-orm';
import { WEBHOOK_EVENT_STATUSES } from '@ghalla/contracts';
import type { Instant, StoreId, WebhookEventStatus } from '@ghalla/contracts';
import type { Database } from '../db/pool.js';
import { webhookEvents } from '../db/schema.js';
import {
  toEnumFromColumn,
  toIdFromColumn,
  toInstantFromDate,
  toDateFromInstant,
} from '../db/codec.js';

/**
 * The queue is a TABLE, not Redis.
 *
 * This row has to exist either way: `unique (store_id, platform_event_id)` is
 * what makes "process once" true against a platform that redelivers, and the
 * raw payload is what makes an event replayable when an adapter turns out to
 * have parsed it wrong. Putting the job in Redis as well would mean the same
 * work lives in two stores that can disagree — and when they disagree while
 * reconciling a merchant's numbers, neither one is authoritative.
 *
 * The decisive reason is narrower than that, though. Writing an `order_profit`
 * row marks its rollup buckets dirty in the SAME transaction, and that atomicity
 * is the whole design. A queue in another process cannot join that transaction:
 * you get a committed row whose follow-up job was lost, or a job for a row that
 * rolled back. `FOR UPDATE SKIP LOCKED` keeps the enqueue, the claim and the
 * business write in one place where a transaction still means something.
 *
 * See docs/0006-ingestion-queue.md for the trigger that would change this.
 */

export interface WebhookEventRecord {
  readonly id: string;
  readonly storeId: StoreId;
  readonly platformEventId: string;
  readonly eventType: string;
  readonly rawEventType: string;
  readonly receivedAt: Instant;
  readonly attempts: number;
  readonly rawPayload: unknown;
}

export interface NewWebhookEvent {
  readonly id: string;
  readonly storeId: StoreId;
  readonly platformEventId: string;
  readonly eventType: string;
  readonly rawEventType: string;
  readonly receivedAt: Instant;
  readonly rawPayload: unknown;
}

/**
 * What an enqueue actually did.
 *
 * `duplicate` is the ordinary case and not an error — platforms redeliver by
 * design, and a queue that logged every redelivery as a failure would bury the
 * real ones. The winning row is findable by `(storeId, platformEventId)` if a
 * caller ever needs it; returning it here cost a second query on every
 * redelivery to answer a question nothing was asking.
 */
export interface EnqueueOutcome {
  readonly duplicate: boolean;
}

export interface RetryPolicy {
  /** First retry delay. Doubles per attempt. */
  readonly baseDelayMs: number;
  /** Ceiling, so attempt 20 is not scheduled next year. */
  readonly maxDelayMs: number;
  /** After this many attempts the row dead-letters instead of retrying. */
  readonly maxAttempts: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  // Ten seconds, because the common failure is a platform 503 or our own deploy
  // rolling, and both are usually over in less time than that.
  baseDelayMs: 10_000,
  maxDelayMs: 3_600_000,
  // Eight attempts spans a little over two hours with this curve. Past that it
  // is not a blip and a human should look, which is what `failed` means.
  maxAttempts: 8,
};

/**
 * Exponential, capped, and deliberately WITHOUT jitter.
 *
 * Jitter exists to stop many workers retrying in lockstep. Claims here are
 * batched by a small number of workers rather than one-job-per-worker, so the
 * herd it protects against does not form — and a deterministic delay is one that
 * a test can assert exactly rather than within a tolerance. If the worker count
 * ever grows enough to matter, add jitter derived from the row id: still
 * deterministic, still testable, and spread.
 */
export function backoffMs(attempts: number, policy: RetryPolicy = DEFAULT_RETRY_POLICY): number {
  // `attempts` is the count INCLUDING the one that just failed, so the first
  // failure (attempts = 1) waits exactly baseDelayMs rather than double it.
  const exponent = Math.max(0, attempts - 1);
  // Clamped before the shift: 2 ** 1024 is Infinity, and Infinity milliseconds
  // is a date Postgres will not take.
  const factor = 2 ** Math.min(exponent, 40);
  return Math.min(policy.baseDelayMs * factor, policy.maxDelayMs);
}

const shift = (at: Instant, ms: number): Date => new Date(new Date(at).getTime() + ms);

/**
 * The ingestion queue.
 *
 * Deliberately NOT a generic job queue. It carries webhook deliveries, whose
 * identity, retry semantics and replay story are all specific — a generic
 * abstraction here would buy reuse we have no second caller for, at the cost of
 * losing the platform-redelivery guarantee that makes the table correct.
 */
export class WebhookEventRepository {
  constructor(
    private readonly db: Database,
    private readonly policy: RetryPolicy = DEFAULT_RETRY_POLICY,
  ) {}

  /**
   * At-least-once delivery meeting exactly-once processing.
   *
   * `ON CONFLICT DO NOTHING` rather than a read-then-write: two deliveries of
   * the same event can race, and a check-then-insert would let both through the
   * check. The unique index is the only thing that actually decides.
   */
  async enqueue(event: NewWebhookEvent): Promise<EnqueueOutcome> {
    const inserted = await this.db
      .insert(webhookEvents)
      .values({
        id: event.id,
        storeId: event.storeId,
        platformEventId: event.platformEventId,
        eventType: event.eventType,
        rawEventType: event.rawEventType,
        receivedAt: toDateFromInstant(event.receivedAt),
        status: 'pending',
        attempts: 0,
        nextAttemptAt: toDateFromInstant(event.receivedAt),
        lockedAt: null,
        rawPayload: event.rawPayload,
      })
      .onConflictDoNothing({ target: [webhookEvents.storeId, webhookEvents.platformEventId] })
      .returning({ id: webhookEvents.id });

    // No row back means the unique index rejected it: a redelivery, or the
    // losing side of a race between two simultaneous ones.
    return { duplicate: inserted.length === 0 };
  }

  /**
   * Takes up to `limit` due rows and marks them in flight.
   *
   * SELECT ... FOR UPDATE SKIP LOCKED is the whole concurrency story: two
   * workers running this simultaneously step over each other's locked rows
   * instead of blocking on them or, worse, both claiming the same event. The
   * SELECT and the UPDATE are one transaction because the lock only lasts that
   * long — split them and the window between is exactly where double-processing
   * lives.
   */
  async claim(limit: number, now: Instant): Promise<readonly WebhookEventRecord[]> {
    if (limit <= 0) return [];
    const at = toDateFromInstant(now);

    return this.db.transaction(async (tx) => {
      const due = await tx
        .select({ id: webhookEvents.id })
        .from(webhookEvents)
        .where(and(eq(webhookEvents.status, 'pending'), lte(webhookEvents.nextAttemptAt, at)))
        // Oldest due first. A queue that is not FIFO under load reorders a
        // store's events, and an order.updated overtaking its own order.created
        // is a canonical order built from the wrong half.
        .orderBy(asc(webhookEvents.nextAttemptAt), asc(webhookEvents.receivedAt))
        .limit(limit)
        .for('update', { skipLocked: true });

      if (due.length === 0) return [];
      const ids = due.map((d) => d.id);

      const claimed = await tx
        .update(webhookEvents)
        .set({
          status: 'processing',
          // Incremented at CLAIM, not at failure. A worker that dies mid-job
          // never reaches its failure handler, and an attempt counter that only
          // rises on a clean failure would let a row that crashes the worker
          // every time retry forever.
          attempts: sql`${webhookEvents.attempts} + 1`,
          lockedAt: at,
        })
        .where(inArray(webhookEvents.id, ids))
        .returning();

      return claimed.map((row) => ({
        id: row.id,
        storeId: toIdFromColumn<'store'>(row.storeId),
        platformEventId: row.platformEventId,
        eventType: row.eventType,
        rawEventType: row.rawEventType,
        receivedAt: toInstantFromDate(row.receivedAt),
        attempts: row.attempts,
        rawPayload: row.rawPayload,
      }));
    });
  }

  /** Done. The lock is cleared because the constraint says only in-flight rows hold one. */
  async markProcessed(id: string, now: Instant): Promise<void> {
    await this.db
      .update(webhookEvents)
      .set({
        status: 'processed',
        processedAt: toDateFromInstant(now),
        lockedAt: null,
        lastError: null,
      })
      .where(eq(webhookEvents.id, id));
  }

  /**
   * Deliberately not processed — an event type this adapter does not handle.
   *
   * Distinct from `processed` so that "we saw it and chose to ignore it" is
   * legible months later, and distinct from `failed` so it does not sit in
   * anyone's dead-letter triage. The reason goes in `last_error` because that
   * column is the row's explanation of any terminal state, not just a bad one.
   */
  async markSkipped(id: string, reason: string, now: Instant): Promise<void> {
    await this.db
      .update(webhookEvents)
      .set({
        status: 'skipped',
        processedAt: toDateFromInstant(now),
        lockedAt: null,
        lastError: reason,
      })
      .where(eq(webhookEvents.id, id));
  }

  /**
   * Failed. Retried until the policy gives up, then dead-lettered.
   *
   * Returns what it decided, because "will be retried" and "a human now has to
   * look at this" are different things to a caller's logs and to its metrics.
   */
  async markFailed(id: string, error: string, now: Instant): Promise<'retrying' | 'dead_lettered'> {
    const [row] = await this.db
      .select({ attempts: webhookEvents.attempts })
      .from(webhookEvents)
      .where(eq(webhookEvents.id, id));
    // Nothing to fail. A purge, or an id that was never claimed.
    if (row === undefined) return 'dead_lettered';

    const exhausted = row.attempts >= this.policy.maxAttempts;
    await this.db
      .update(webhookEvents)
      .set({
        status: exhausted ? 'failed' : 'pending',
        lockedAt: null,
        lastError: error,
        nextAttemptAt: exhausted
          ? toDateFromInstant(now)
          : shift(now, backoffMs(row.attempts, this.policy)),
      })
      .where(eq(webhookEvents.id, id));

    return exhausted ? 'dead_lettered' : 'retrying';
  }

  /**
   * Frees rows whose worker died holding them.
   *
   * Without this, every crash leaks one row per in-flight job permanently:
   * `processing` is not claimable, and nothing else would ever move it. The
   * staleness threshold has to exceed the longest legitimate job, or this
   * releases work that is still running and the event gets processed twice.
   *
   * Rows that have already exhausted their attempts dead-letter here rather
   * than looping — a job that reliably kills its worker is the exact case this
   * would otherwise retry forever.
   */
  async reapStale(staleAfterMs: number, now: Instant): Promise<number> {
    const cutoff = shift(now, -staleAfterMs);
    const stale = await this.db
      .select({ id: webhookEvents.id, attempts: webhookEvents.attempts })
      .from(webhookEvents)
      .where(and(eq(webhookEvents.status, 'processing'), lt(webhookEvents.lockedAt, cutoff)));
    if (stale.length === 0) return 0;

    const dead = stale.filter((r) => r.attempts >= this.policy.maxAttempts).map((r) => r.id);
    const retry = stale.filter((r) => r.attempts < this.policy.maxAttempts);

    await this.db.transaction(async (tx) => {
      if (dead.length > 0) {
        await tx
          .update(webhookEvents)
          .set({
            status: 'failed',
            lockedAt: null,
            lastError: 'abandoned by a worker after exhausting its attempts',
            nextAttemptAt: toDateFromInstant(now),
          })
          .where(inArray(webhookEvents.id, dead));
      }
      for (const row of retry) {
        await tx
          .update(webhookEvents)
          .set({
            status: 'pending',
            lockedAt: null,
            lastError: 'reclaimed after a worker stopped reporting',
            nextAttemptAt: shift(now, backoffMs(row.attempts, this.policy)),
          })
          .where(eq(webhookEvents.id, row.id));
      }
    });

    return stale.length;
  }

  /**
   * Puts a dead letter back in the queue.
   *
   * A dead-letter queue with no way out is just a table of regrets. The attempt
   * counter resets because the operator replaying this has presumably fixed
   * whatever caused the failure, and starting at the exhausted count would
   * dead-letter it again on the first hiccup.
   */
  async requeue(id: string, now: Instant): Promise<boolean> {
    const updated = await this.db
      .update(webhookEvents)
      .set({
        status: 'pending',
        attempts: 0,
        lockedAt: null,
        nextAttemptAt: toDateFromInstant(now),
        processedAt: null,
      })
      .where(and(eq(webhookEvents.id, id), eq(webhookEvents.status, 'failed')))
      .returning({ id: webhookEvents.id });
    return updated.length > 0;
  }

  /** Queue depth by status. The number an operator actually wants when something is wrong. */
  async countByStatus(): Promise<Readonly<Record<WebhookEventStatus, number>>> {
    const rows = await this.db
      .select({ status: webhookEvents.status, count: sql<number>`count(*)::int` })
      .from(webhookEvents)
      .groupBy(webhookEvents.status);

    const counts: Record<WebhookEventStatus, number> = {
      pending: 0,
      processing: 0,
      processed: 0,
      failed: 0,
      skipped: 0,
    };
    for (const row of rows) {
      // Through the codec rather than a cast: if a status ever escapes the
      // CHECK constraint, this says which column and which value, instead of
      // silently dropping the row from a number an operator is trusting.
      counts[toEnumFromColumn(row.status, WEBHOOK_EVENT_STATUSES, 'webhook_events.status')] =
        row.count;
    }
    return counts;
  }
}
