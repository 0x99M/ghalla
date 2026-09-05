import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import path from 'node:path';
import * as portalSchema from '../src/lib/db/portal-schema';

/**
 * The portal's migration applied to a real Postgres — PGlite is Postgres
 * compiled to WebAssembly, in this process.
 *
 * The CHECK constraints are the reason. Every one of them carries a rule that
 * the comment beside it claims is enforced, and a rule the database does not
 * actually enforce is worse than no rule at all. One of these constraints was
 * already wrong once — an unbracketed `OR` inside an `AND` chain, which reads
 * correctly and constrains nothing — and it was reading the generated SQL that
 * caught it, not reading the TypeScript.
 */
let client: PGlite;

const MIGRATIONS = path.resolve(import.meta.dirname, '..', 'drizzle');

beforeAll(async () => {
  client = new PGlite();
  await migrate(drizzle({ client, schema: portalSchema }), { migrationsFolder: MIGRATIONS });
}, 60_000);

afterAll(async () => {
  await client.close();
});

async function rejects(statement: string, constraint: string): Promise<void> {
  await expect(client.exec(statement)).rejects.toThrow(new RegExp(constraint));
}

const HOUR = `'2026-09-05T09:00:00Z'`;

const OK_SNAPSHOT = (hour = HOUR) => `
  INSERT INTO platform_snapshot (platform, captured_hour, status, active_stores, trialing_stores,
    past_due_stores, canceled_stores, expired_stores, list_mrr_minor, unknown_plan_subscriptions,
    orders_ingested_live_24h, webhooks_processed_24h, webhooks_failed_24h, queue_depth, queue_stalled)
  VALUES ('demo', ${hour}, 'ok', 10, 2, 1, 0, 0, '4900.00', 0, 120, 500, 3, 4, 0)`;

describe('migration', () => {
  it('applies cleanly and creates the portal tables', async () => {
    const result = await client.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`,
    );
    const tables = result.rows.map((r) => r.table_name).filter((n) => !n.startsWith('__drizzle'));
    expect(tables).toEqual(['admin_action_log', 'alert_ack', 'platform_snapshot', 'store_snapshot']);
  });

  it('holds no foreign key to a store, because that store is in another database', async () => {
    const result = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM information_schema.table_constraints
       WHERE table_schema = 'public' AND constraint_type = 'FOREIGN KEY'`,
    );
    expect(result.rows[0]?.count).toBe('0');
  });
});

describe('platform_snapshot', () => {
  it('accepts a complete hourly row', async () => {
    await expect(client.exec(OK_SNAPSHOT())).resolves.toBeDefined();
  });

  it('lets a re-run inside the same hour REPLACE rather than duplicate', async () => {
    await client.exec(`${OK_SNAPSHOT(`'2026-09-05T11:00:00Z'`)}
      ON CONFLICT (platform, captured_hour) DO UPDATE SET active_stores = 99`);
    await client.exec(`${OK_SNAPSHOT(`'2026-09-05T11:00:00Z'`)}
      ON CONFLICT (platform, captured_hour) DO UPDATE SET active_stores = 99`);

    const rows = await client.query<{ active_stores: number }>(
      `SELECT active_stores FROM platform_snapshot WHERE captured_hour = '2026-09-05T11:00:00Z'`,
    );
    expect(rows.rows).toEqual([{ active_stores: 99 }]);
  });

  it('refuses an unaligned hour, which would defeat that primary key', async () => {
    await rejects(
      OK_SNAPSHOT(`'2026-09-05T09:17:00Z'`),
      'platform_snapshot_hour_aligned',
    );
  });

  it('refuses a row that is neither a reading nor a failure', async () => {
    await rejects(
      `INSERT INTO platform_snapshot (platform, captured_hour, status) VALUES ('demo', '2026-09-05T12:00:00Z', 'ok')`,
      'platform_snapshot_metrics_iff_ok',
    );
  });

  it('refuses a reading that also carries an error', async () => {
    await rejects(
      `INSERT INTO platform_snapshot (platform, captured_hour, status, active_stores, error)
       VALUES ('demo', '2026-09-05T13:00:00Z', 'ok', 3, 'timeout')`,
      'platform_snapshot_error_iff_unreachable',
    );
  });

  it('accepts an unreachable row, which is how a failed sweep stays distinguishable from no sweep', async () => {
    await expect(
      client.exec(`INSERT INTO platform_snapshot (platform, captured_hour, status, error)
        VALUES ('demo', '2026-09-05T14:00:00Z', 'unreachable', 'connection refused')`),
    ).resolves.toBeDefined();
  });

  it('refuses an unknown status', async () => {
    // No metrics and no error, so the two `iff` constraints are both satisfied
    // and the status check is the one left to fail. A row that violates three
    // constraints tells you only which one Postgres happened to evaluate first.
    await rejects(
      `INSERT INTO platform_snapshot (platform, captured_hour, status)
       VALUES ('demo', '2026-09-05T15:00:00Z', 'probably')`,
      'platform_snapshot_status_valid',
    );
  });

  it('refuses a negative count on EVERY count column, not just the first', async () => {
    // The bracketing bug this constraint had made it true whenever its last
    // term was, so a negative anywhere else passed. One assertion per column.
    for (const column of [
      'active_stores',
      'trialing_stores',
      'past_due_stores',
      'canceled_stores',
      'expired_stores',
      'unknown_plan_subscriptions',
      'orders_ingested_live_24h',
      'webhooks_processed_24h',
      'webhooks_failed_24h',
      'queue_depth',
      'queue_stalled',
    ]) {
      const statement =
        column === 'active_stores'
          ? `INSERT INTO platform_snapshot (platform, captured_hour, status, active_stores)
             VALUES ('demo', '2026-09-05T16:00:00Z', 'ok', -1)`
          : `INSERT INTO platform_snapshot (platform, captured_hour, status, active_stores, ${column})
             VALUES ('demo', '2026-09-05T16:00:00Z', 'ok', 1, -1)`;
      await rejects(statement, 'platform_snapshot_counts_positive');
    }
  });
});

describe('store_snapshot', () => {
  const OK_STORE = `INSERT INTO store_snapshot (platform, store_id, captured_date, plan_code, status,
    orders_in_period, coverage_revenue_ex_vat_minor, coverage_covered_revenue_ex_vat_minor)
    VALUES ('demo', 'demo:1', '2026-09-05', 'growth', 'active', 40, '1000.00', '600.00')`;

  it('accepts a daily row', async () => {
    await expect(client.exec(OK_STORE)).resolves.toBeDefined();
  });

  it('refuses covered revenue larger than the revenue it is a share of', async () => {
    await rejects(
      `INSERT INTO store_snapshot (platform, store_id, captured_date, plan_code, status,
        coverage_revenue_ex_vat_minor, coverage_covered_revenue_ex_vat_minor)
       VALUES ('demo', 'demo:2', '2026-09-05', 'growth', 'active', '100.00', '101.00')`,
      'store_snapshot_coverage_bounded',
    );
  });

  it('allows either coverage term to be unknown', async () => {
    await expect(
      client.exec(`INSERT INTO store_snapshot (platform, store_id, captured_date, plan_code, status,
        coverage_revenue_ex_vat_minor) VALUES ('demo', 'demo:3', '2026-09-05', 'growth', 'active', '100.00')`),
    ).resolves.toBeDefined();
  });

  it('refuses a negative order count', async () => {
    await rejects(
      `INSERT INTO store_snapshot (platform, store_id, captured_date, plan_code, status, orders_in_period)
       VALUES ('demo', 'demo:4', '2026-09-05', 'growth', 'active', -1)`,
      'store_snapshot_orders_positive',
    );
  });

  it('stores money as an exact decimal, not a float', async () => {
    const rows = await client.query<{ coverage_revenue_ex_vat_minor: string }>(
      `SELECT coverage_revenue_ex_vat_minor FROM store_snapshot WHERE store_id = 'demo:1'`,
    );
    // A string, digit for digit. Reading this with Number() is the bug the
    // codec exists to prevent.
    expect(rows.rows[0]?.coverage_revenue_ex_vat_minor).toBe('1000.00');
  });
});

describe('admin_action_log', () => {
  it('accepts an action that has been dispatched and not yet answered', async () => {
    await expect(
      client.exec(`INSERT INTO admin_action_log (id, actor_session, platform, action, params)
        VALUES ('a1', 'session-1', 'demo', 'recompute', '{"storeId":"demo:1"}')`),
    ).resolves.toBeDefined();
  });

  it('refuses a settled action with no completion time', async () => {
    // A row that claims success while looking like it never returned is the one
    // shape this table must never hold: the 03:00 question is exactly "what did
    // we fire off and never hear back about".
    await rejects(
      `INSERT INTO admin_action_log (id, actor_session, platform, action, params, status)
       VALUES ('a2', 'session-1', 'demo', 'recompute', '{}', 'succeeded')`,
      'admin_action_log_completed_iff_settled',
    );
  });

  it('refuses a dispatched action that already has one', async () => {
    await rejects(
      `INSERT INTO admin_action_log (id, actor_session, platform, action, params, status, completed_at)
       VALUES ('a3', 'session-1', 'demo', 'recompute', '{}', 'dispatched', now())`,
      'admin_action_log_completed_iff_settled',
    );
  });

  it('refuses an unknown status', async () => {
    await rejects(
      `INSERT INTO admin_action_log (id, actor_session, platform, action, params, status, completed_at)
       VALUES ('a4', 'session-1', 'demo', 'recompute', '{}', 'maybe', now())`,
      'admin_action_log_status_valid',
    );
  });
});

describe('alert_ack', () => {
  it('keys an acknowledgement by the alert key, so it survives recomputation', async () => {
    await client.exec(`INSERT INTO alert_ack (alert_key, note) VALUES ('silent_store:demo:1', 'chasing')`);
    await rejects(
      `INSERT INTO alert_ack (alert_key) VALUES ('silent_store:demo:1')`,
      'alert_ack_pkey',
    );
  });

  it('records when it was acknowledged, because expiry is read from it', async () => {
    const rows = await client.query<{ acknowledged_at: Date }>(
      `SELECT acknowledged_at FROM alert_ack WHERE alert_key = 'silent_store:demo:1'`,
    );
    expect(rows.rows[0]?.acknowledged_at).toBeInstanceOf(Date);
  });
});
