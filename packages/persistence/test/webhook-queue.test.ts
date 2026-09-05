import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { eq, sql } from 'drizzle-orm';
import path from 'node:path';
import { idFromString, toInstant } from '@ghalla/contracts';
import type { Instant, StoreId } from '@ghalla/contracts';
import * as schema from '../src/db/schema.js';
import {
  DEFAULT_RETRY_POLICY,
  WebhookEventRepository,
  backoffMs,
} from '../src/repositories/webhook-event.repository.js';
import type { NewWebhookEvent, RetryPolicy } from '../src/repositories/webhook-event.repository.js';

/**
 * The queue, against a real Postgres running the real migrations.
 *
 * One limitation stated up front: PGlite is a single backend, so these tests
 * cannot run two workers claiming at the same instant. What they DO cover is
 * that the claim statement is valid SQL with SKIP LOCKED against the real
 * planner, and every state transition the workers depend on. Genuine
 * concurrency is a property of `FOR UPDATE SKIP LOCKED` itself rather than of
 * this code, and testing Postgres's locking is not our job.
 */
let client: PGlite;
let db: ReturnType<typeof drizzle<typeof schema>>;
let repo: WebhookEventRepository;

const STORE_ID = idFromString<'store'>('demo:1') as StoreId;
const T0 = toInstant('2026-03-01T10:00:00.000Z');

const at = (offsetMs: number): Instant =>
  toInstant(new Date(new Date(T0).getTime() + offsetMs).toISOString());

const event = (over: Partial<NewWebhookEvent> = {}): NewWebhookEvent => ({
  id: 'we_1',
  storeId: STORE_ID,
  platformEventId: 'evt_1',
  eventType: 'order.updated',
  rawEventType: 'order.status.updated',
  receivedAt: T0,
  rawPayload: { id: 1001 },
  ...over,
});

const statusOf = async (id: string): Promise<string | undefined> => {
  const [row] = await db
    .select({ status: schema.webhookEvents.status })
    .from(schema.webhookEvents)
    .where(eq(schema.webhookEvents.id, id));
  return row?.status;
};

const rowOf = async (
  id: string,
): Promise<{ status: string; attempts: number; lockedAt: Date | null; nextAttemptAt: Date; lastError: string | null } | undefined> => {
  const [row] = await db
    .select({
      status: schema.webhookEvents.status,
      attempts: schema.webhookEvents.attempts,
      lockedAt: schema.webhookEvents.lockedAt,
      nextAttemptAt: schema.webhookEvents.nextAttemptAt,
      lastError: schema.webhookEvents.lastError,
    })
    .from(schema.webhookEvents)
    .where(eq(schema.webhookEvents.id, id));
  return row;
};

beforeAll(async () => {
  client = new PGlite();
  db = drizzle({ client, schema });
  await migrate(db, { migrationsFolder: path.resolve(import.meta.dirname, '..', 'drizzle') });
  await db.insert(schema.stores).values({
    id: STORE_ID,
    platform: 'demo',
    platformStoreId: '1',
    currency: 'SAR',
    timezone: 'Asia/Riyadh',
    vatRateBps: 1500,
    vatRegistered: true,
    installedAt: new Date('2026-01-01T00:00:00.000Z'),
  });
  repo = new WebhookEventRepository(db);
});

afterAll(async () => {
  await client.close();
});

beforeEach(async () => {
  await db.delete(schema.webhookEvents);
});

describe('enqueueing a delivery', () => {
  it('accepts a new event and queues it due immediately', async () => {
    const outcome = await repo.enqueue(event());
    expect(outcome).toStrictEqual({ duplicate: false });
    const row = await rowOf('we_1');
    expect(row?.status).toBe('pending');
    expect(row?.attempts).toBe(0);
    expect(row?.lockedAt).toBeNull();
  });

  it('treats a redelivery as a duplicate and keeps only the first row', async () => {
    // Platforms redeliver by design; this is the ordinary path, not an error.
    // The second delivery must not create a second row, or the same order is
    // computed twice.
    await repo.enqueue(event({ id: 'we_first' }));
    const second = await repo.enqueue(event({ id: 'we_second' }));
    expect(second).toStrictEqual({ duplicate: true });

    const [count] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.webhookEvents);
    expect(count?.n).toBe(1);
  });

  it('keeps events from different stores apart even under the same platform id', async () => {
    // The unique key is (store_id, platform_event_id). Two merchants' platforms
    // number their events independently, so a collision across stores is normal
    // and must not swallow one of them.
    await db.insert(schema.stores).values({
      id: idFromString<'store'>('demo:2') as StoreId,
      platform: 'demo',
      platformStoreId: '2',
      currency: 'SAR',
      timezone: 'Asia/Riyadh',
      vatRateBps: 1500,
      vatRegistered: true,
      installedAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    const a = await repo.enqueue(event({ id: 'we_a' }));
    const b = await repo.enqueue(
      event({ id: 'we_b', storeId: idFromString<'store'>('demo:2') as StoreId }),
    );
    expect(a.duplicate).toBe(false);
    expect(b.duplicate).toBe(false);
  });
});

describe('claiming work', () => {
  it('takes a due row, marks it in flight and counts the attempt', async () => {
    await repo.enqueue(event());
    const claimed = await repo.claim(10, at(0));
    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.id).toBe('we_1');
    expect(claimed[0]?.attempts).toBe(1);

    const row = await rowOf('we_1');
    expect(row?.status).toBe('processing');
    // Counted at claim, not at failure: a worker that dies never reaches its
    // failure handler, and a counter that only rises on a clean failure lets a
    // row that crashes the worker retry forever.
    expect(row?.attempts).toBe(1);
    expect(row?.lockedAt).not.toBeNull();
  });

  it('does not hand the same row to a second claim', async () => {
    await repo.enqueue(event());
    await repo.claim(10, at(0));
    // Already `processing`, so it is out of the claimable set entirely.
    expect(await repo.claim(10, at(0))).toHaveLength(0);
  });

  it('leaves a row alone until it is due', async () => {
    await repo.enqueue(event({ receivedAt: at(60_000) }));
    expect(await repo.claim(10, at(0))).toHaveLength(0);
    expect(await repo.claim(10, at(60_000))).toHaveLength(1);
  });

  it('serves the oldest due row first', async () => {
    // A queue that is not FIFO reorders a store's events, and an order.updated
    // overtaking its own order.created builds a canonical order from the wrong
    // half.
    await repo.enqueue(event({ id: 'we_late', platformEventId: 'evt_late', receivedAt: at(2_000) }));
    await repo.enqueue(
      event({ id: 'we_early', platformEventId: 'evt_early', receivedAt: at(1_000) }),
    );
    const claimed = await repo.claim(1, at(10_000));
    expect(claimed[0]?.id).toBe('we_early');
  });

  it('honours the batch limit', async () => {
    for (let i = 0; i < 5; i += 1) {
      await repo.enqueue(event({ id: `we_${String(i)}`, platformEventId: `evt_${String(i)}` }));
    }
    expect(await repo.claim(2, at(0))).toHaveLength(2);
  });

  it('asks the database for nothing when the limit is not positive', async () => {
    await repo.enqueue(event());
    expect(await repo.claim(0, at(0))).toStrictEqual([]);
    // The row is untouched — a zero-size batch must not consume an attempt.
    expect(await statusOf('we_1')).toBe('pending');
  });

  it('returns an empty batch rather than failing when nothing is due', async () => {
    expect(await repo.claim(10, at(0))).toStrictEqual([]);
  });
});

describe('finishing work', () => {
  it('marks a row processed and releases its lock', async () => {
    await repo.enqueue(event());
    await repo.claim(10, at(0));
    await repo.markProcessed('we_1', at(1_000));
    const row = await rowOf('we_1');
    expect(row?.status).toBe('processed');
    // The CHECK constraint would have rejected the write outright if the lock
    // were left behind, which is precisely why it exists.
    expect(row?.lockedAt).toBeNull();
  });

  it('records a deliberate skip separately from a failure', async () => {
    // "We saw it and chose to ignore it" must stay legible months later, and
    // must not sit in anyone's dead-letter triage.
    await repo.enqueue(event());
    await repo.claim(10, at(0));
    await repo.markSkipped('we_1', 'event type not handled by this adapter', at(1_000));
    const row = await rowOf('we_1');
    expect(row?.status).toBe('skipped');
    expect(row?.lastError).toBe('event type not handled by this adapter');
    expect(row?.lockedAt).toBeNull();
  });
});

describe('failing work', () => {
  it('schedules a retry into the future rather than at the head of the queue', async () => {
    await repo.enqueue(event());
    await repo.claim(10, at(0));
    const outcome = await repo.markFailed('we_1', 'platform returned 503', at(1_000));
    expect(outcome).toBe('retrying');

    const row = await rowOf('we_1');
    expect(row?.status).toBe('pending');
    expect(row?.lastError).toBe('platform returned 503');
    // First failure waits exactly the base delay. Without this the row is
    // re-claimed as fast as the worker can fail it and starves everything
    // healthy behind it.
    expect(row?.nextAttemptAt.getTime()).toBe(new Date(at(1_000)).getTime() + 10_000);
    // And it really is not claimable yet.
    expect(await repo.claim(10, at(1_000))).toHaveLength(0);
    expect(await repo.claim(10, at(11_000))).toHaveLength(1);
  });

  it('dead-letters once the attempts are spent', async () => {
    const policy: RetryPolicy = { baseDelayMs: 1_000, maxDelayMs: 10_000, maxAttempts: 2 };
    const strict = new WebhookEventRepository(db, policy);
    await strict.enqueue(event());

    await strict.claim(10, at(0));
    expect(await strict.markFailed('we_1', 'boom', at(0))).toBe('retrying');
    await strict.claim(10, at(10_000));
    expect(await strict.markFailed('we_1', 'boom again', at(10_000))).toBe('dead_lettered');

    const row = await rowOf('we_1');
    expect(row?.status).toBe('failed');
    expect(row?.attempts).toBe(2);
    // Terminal: the sweep must not pick it up again on its own.
    expect(await strict.claim(10, at(999_999))).toHaveLength(0);
  });

  it('reports a dead letter rather than throwing when the row is gone', async () => {
    // A purge running concurrently with a worker. Nothing to retry, and the
    // caller should not get an exception for losing a race with retention.
    expect(await repo.markFailed('we_missing', 'gone', at(0))).toBe('dead_lettered');
  });
});

describe('reaping a worker that died holding rows', () => {
  it('frees a stale in-flight row so it can be claimed again', async () => {
    // Without this, every crash leaks one row per in-flight job permanently:
    // `processing` is not claimable and nothing else would ever move it.
    await repo.enqueue(event());
    await repo.claim(10, at(0));

    expect(await repo.reapStale(60_000, at(600_000))).toBe(1);
    const row = await rowOf('we_1');
    expect(row?.status).toBe('pending');
    expect(row?.lockedAt).toBeNull();
    expect(row?.lastError).toBe('reclaimed after a worker stopped reporting');
  });

  it('leaves a row alone while its worker is still within the threshold', async () => {
    // The threshold has to exceed the longest legitimate job, or this releases
    // work that is still running and the event is processed twice.
    await repo.enqueue(event());
    await repo.claim(10, at(0));
    expect(await repo.reapStale(60_000, at(30_000))).toBe(0);
    expect(await statusOf('we_1')).toBe('processing');
  });

  it('dead-letters a row that has already exhausted its attempts', async () => {
    // A job that reliably kills its worker is the exact case a naive reaper
    // would retry forever.
    const policy: RetryPolicy = { baseDelayMs: 1_000, maxDelayMs: 10_000, maxAttempts: 1 };
    const strict = new WebhookEventRepository(db, policy);
    await strict.enqueue(event());
    await strict.claim(10, at(0));

    expect(await strict.reapStale(60_000, at(600_000))).toBe(1);
    const row = await rowOf('we_1');
    expect(row?.status).toBe('failed');
    expect(row?.lastError).toBe('abandoned by a worker after exhausting its attempts');
  });

  it('reaps a mixed batch, sending each row where it belongs', async () => {
    const policy: RetryPolicy = { baseDelayMs: 1_000, maxDelayMs: 10_000, maxAttempts: 2 };
    const strict = new WebhookEventRepository(db, policy);
    await strict.enqueue(event({ id: 'we_fresh', platformEventId: 'evt_fresh' }));
    await strict.enqueue(event({ id: 'we_spent', platformEventId: 'evt_spent' }));
    // Burn one row's attempts down to the limit, then strand both in flight.
    await strict.claim(10, at(0));
    await strict.markFailed('we_spent', 'once', at(0));
    await strict.claim(10, at(10_000));

    expect(await strict.reapStale(60_000, at(600_000))).toBe(2);
    expect(await statusOf('we_fresh')).toBe('pending');
    expect(await statusOf('we_spent')).toBe('failed');
  });

  it('does nothing, cheaply, when no row is in flight', async () => {
    expect(await repo.reapStale(60_000, at(600_000))).toBe(0);
  });
});

describe('replaying a dead letter', () => {
  it('puts a failed row back in the queue with a clean attempt count', async () => {
    // A dead-letter queue with no way out is a table of regrets.
    const policy: RetryPolicy = { baseDelayMs: 1_000, maxDelayMs: 10_000, maxAttempts: 1 };
    const strict = new WebhookEventRepository(db, policy);
    await strict.enqueue(event());
    await strict.claim(10, at(0));
    await strict.markFailed('we_1', 'boom', at(0));
    expect(await statusOf('we_1')).toBe('failed');

    expect(await strict.requeue('we_1', at(100_000))).toBe(true);
    const row = await rowOf('we_1');
    expect(row?.status).toBe('pending');
    // Reset, because the operator replaying this has presumably fixed the
    // cause; starting at the exhausted count dead-letters it on the first
    // hiccup.
    expect(row?.attempts).toBe(0);
    expect(await strict.claim(10, at(100_000))).toHaveLength(1);
  });

  it('refuses to replay a row that has not failed', async () => {
    // Requeueing a `processing` row would hand the same event to a second
    // worker while the first is still on it.
    await repo.enqueue(event());
    await repo.claim(10, at(0));
    expect(await repo.requeue('we_1', at(1_000))).toBe(false);
    expect(await statusOf('we_1')).toBe('processing');
  });

  it('reports false for an id that does not exist', async () => {
    expect(await repo.requeue('we_missing', at(0))).toBe(false);
  });
});

describe('queue depth', () => {
  it('counts every status, including the ones at zero', async () => {
    // An operator asking "what is wrong" needs the zeroes as much as the
    // totals: a missing key reads as "no data", not as "none stuck".
    await repo.enqueue(event({ id: 'we_a', platformEventId: 'evt_a' }));
    await repo.enqueue(event({ id: 'we_b', platformEventId: 'evt_b' }));
    await repo.claim(1, at(0));

    expect(await repo.countByStatus()).toStrictEqual({
      pending: 1,
      processing: 1,
      processed: 0,
      failed: 0,
      skipped: 0,
    });
  });
});

describe('the database refuses a broken lock', () => {
  // Raw SQL rather than the query builder, matching schema.test.ts: the driver
  // names the constraint it rejected, and drizzle wraps that in a generic
  // "Failed query" whose message would let this assertion pass for the wrong
  // reason.
  const rejects = (statement: string): Promise<void> =>
    expect(client.exec(statement)).rejects.toThrow(/webhook_events_lock_iff_processing/);

  it('rejects an in-flight row with no lock timestamp', async () => {
    // The constraint is the reason the reaper's contract holds: a `processing`
    // row with no `locked_at` is invisible to it and stuck forever.
    await repo.enqueue(event());
    await rejects(
      `UPDATE webhook_events SET status = 'processing', locked_at = NULL WHERE id = 'we_1'`,
    );
  });

  it('rejects a released row that kept its lock', async () => {
    // The other half: a phantom the reaper would keep "recovering".
    await repo.enqueue(event());
    await rejects(
      `UPDATE webhook_events SET status = 'processed', locked_at = now() WHERE id = 'we_1'`,
    );
  });
});

describe('the retry curve', () => {
  it('doubles from the base delay', () => {
    expect(backoffMs(1)).toBe(10_000);
    expect(backoffMs(2)).toBe(20_000);
    expect(backoffMs(3)).toBe(40_000);
  });

  it('never exceeds the ceiling', () => {
    expect(backoffMs(50)).toBe(DEFAULT_RETRY_POLICY.maxDelayMs);
    // The clamp is on the EXPONENT as well: 2 ** 1024 is Infinity, and
    // Infinity milliseconds is a date Postgres will not take.
    expect(Number.isFinite(backoffMs(5_000))).toBe(true);
  });

  it('treats a zeroth attempt as the first, rather than halving the delay', () => {
    expect(backoffMs(0)).toBe(10_000);
  });

  it('honours a caller-supplied policy', () => {
    const policy: RetryPolicy = { baseDelayMs: 500, maxDelayMs: 2_000, maxAttempts: 5 };
    expect(backoffMs(1, policy)).toBe(500);
    expect(backoffMs(2, policy)).toBe(1_000);
    expect(backoffMs(9, policy)).toBe(2_000);
  });
});
