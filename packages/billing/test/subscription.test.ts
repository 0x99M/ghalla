import { describe, expect, it } from 'vitest';
import { toInstant } from '@ghalla/contracts';
import type { Instant, StoreId } from '@ghalla/contracts';
import { applyChange, differsFrom, isStale, reconcile } from '../src/subscription.js';
import type { Subscription, SubscriptionChange } from '../src/subscription.js';

const STORE = 'demo:1' as StoreId;
const at = (iso: string): Instant => toInstant(iso);

const subscription = (over: Partial<Subscription> = {}): Subscription => ({
  storeId: STORE,
  planCode: 'growth',
  platformPlanId: 'plat_2',
  status: 'active',
  trialEndsAt: null,
  currentPeriodStart: at('2026-03-01T00:00:00.000Z'),
  currentPeriodEnd: at('2026-04-01T00:00:00.000Z'),
  lastEventAt: at('2026-03-10T00:00:00.000Z'),
  lastReconciledAt: null,
  pendingPlanCode: null,
  pendingPlanEffectiveAt: null,
  ...over,
});

const change = (over: Partial<SubscriptionChange> = {}): SubscriptionChange => ({
  status: 'active',
  planCode: null,
  platformPlanId: null,
  trialEndsAt: null,
  currentPeriodStart: null,
  currentPeriodEnd: null,
  occurredAt: at('2026-03-15T00:00:00.000Z'),
  ...over,
});

describe('the stale-event guard', () => {
  it('drops an event older than the last one applied', () => {
    expect(isStale(subscription(), at('2026-03-09T00:00:00.000Z'))).toBe(true);
  });

  it('drops an event stamped the SAME instant as the last one', () => {
    // Two events at one timestamp cannot be ordered by their timestamps, so
    // applying the second is a coin flip — and one face of that coin revokes a
    // paying merchant's access. Refusing both is the safe half: the nightly
    // reconciler repairs a missed change, and nothing repairs a wrongly
    // revoked one except a support ticket.
    expect(isStale(subscription(), at('2026-03-10T00:00:00.000Z'))).toBe(true);
  });

  it('accepts a newer event', () => {
    expect(isStale(subscription(), at('2026-03-11T00:00:00.000Z'))).toBe(false);
  });

  it('accepts anything when nothing has been applied yet', () => {
    expect(isStale(subscription({ lastEventAt: null }), at('2020-01-01T00:00:00.000Z'))).toBe(false);
  });
});

describe('a cancellation that arrives after a renewal', () => {
  it('does not downgrade a merchant who has just paid', () => {
    // THE case this guard exists for. Platforms deliver out of order; the cancel
    // was issued on the 5th and arrives after the renewal issued on the 10th.
    // Applying it locks out someone whose card has just been charged, and
    // nothing in the system would notice until they wrote in.
    const renewed = subscription({ status: 'active', lastEventAt: at('2026-03-10T00:00:00.000Z') });
    const lateCancel = change({ status: 'canceled', occurredAt: at('2026-03-05T00:00:00.000Z') });

    const outcome = applyChange(renewed, lateCancel);
    expect(outcome.kind).toBe('stale');
    if (outcome.kind === 'stale') expect(outcome.reason).toContain('2026-03-05');
  });

  it('applies a cancellation that genuinely is the newest word', () => {
    const outcome = applyChange(
      subscription(),
      change({ status: 'canceled', occurredAt: at('2026-03-20T00:00:00.000Z') }),
    );
    expect(outcome.kind).toBe('applied');
    if (outcome.kind === 'applied') {
      expect(outcome.next.status).toBe('canceled');
      expect(outcome.next.lastEventAt).toBe(at('2026-03-20T00:00:00.000Z'));
    }
  });
});

describe('a duplicate delivery of the same event', () => {
  it('is idempotent — the second application is dropped as stale', () => {
    // At-least-once delivery is normal. The first application advances
    // lastEventAt to the event's own instant, which makes the redelivery
    // compare equal and fall to the `<=` guard.
    const first = applyChange(subscription({ lastEventAt: null }), change({ status: 'canceled' }));
    expect(first.kind).toBe('applied');
    if (first.kind !== 'applied') return;

    const second = applyChange(first.next, change({ status: 'canceled' }));
    expect(second.kind).toBe('stale');
  });
});

describe('what a silent field means', () => {
  it('treats null as "the event did not say", never as "clear it"', () => {
    // A cancellation notice carries no period dates. Reading its silence as an
    // instruction would wipe the window the usage count is measured against,
    // resetting a merchant's order count mid-cycle.
    const current = subscription();
    const outcome = applyChange(current, change({ status: 'canceled' }));
    expect(outcome.kind).toBe('applied');
    if (outcome.kind !== 'applied') return;
    expect(outcome.next.currentPeriodStart).toBe(current.currentPeriodStart);
    expect(outcome.next.currentPeriodEnd).toBe(current.currentPeriodEnd);
    expect(outcome.next.planCode).toBe('growth');
    expect(outcome.next.platformPlanId).toBe('plat_2');
  });

  it('takes every field the event does supply', () => {
    const outcome = applyChange(
      subscription(),
      change({
        status: 'active',
        planCode: 'scale',
        platformPlanId: 'plat_9',
        currentPeriodStart: at('2026-04-01T00:00:00.000Z'),
        currentPeriodEnd: at('2026-05-01T00:00:00.000Z'),
        trialEndsAt: at('2026-03-20T00:00:00.000Z'),
      }),
    );
    expect(outcome.kind).toBe('applied');
    if (outcome.kind !== 'applied') return;
    expect(outcome.next.planCode).toBe('scale');
    expect(outcome.next.platformPlanId).toBe('plat_9');
    expect(outcome.next.currentPeriodEnd).toBe(at('2026-05-01T00:00:00.000Z'));
    expect(outcome.next.trialEndsAt).toBe(at('2026-03-20T00:00:00.000Z'));
  });
});

describe('reconciliation', () => {
  const now = at('2026-03-31T03:00:00.000Z');

  it('reports agreement without writing anything', () => {
    // The correction count is only a useful signal if its baseline is silence.
    // Reporting a correction every night for every store would bury the one
    // night it means something.
    const outcome = reconcile(subscription(), change({ status: 'active' }), now);
    expect(outcome.kind).toBe('unchanged');
  });

  it('overrides local state even when no newer event has arrived', () => {
    // The one path allowed to move state backwards. A webhook is a claim about
    // a moment; this is the platform's current answer, and if it disagrees then
    // we are wrong regardless of what our newest event said.
    const stale = subscription({ status: 'active', lastEventAt: at('2026-03-30T00:00:00.000Z') });
    const truth = change({ status: 'canceled', occurredAt: at('2026-03-20T00:00:00.000Z') });

    const outcome = reconcile(stale, truth, now);
    expect(outcome.kind).toBe('applied');
    if (outcome.kind !== 'applied') return;
    expect(outcome.next.status).toBe('canceled');
  });

  it('does not advance lastEventAt', () => {
    // That field orders WEBHOOKS against each other. Stamping it during a
    // reconciliation would make this pass silently discard the next genuine
    // webhook older than it.
    const current = subscription();
    const outcome = reconcile(current, change({ status: 'past_due' }), now);
    expect(outcome.kind).toBe('applied');
    if (outcome.kind !== 'applied') return;
    expect(outcome.next.lastEventAt).toBe(current.lastEventAt);
    expect(outcome.next.lastReconciledAt).toBe(now);
  });

  it('notices every field that can drift', () => {
    const current = subscription();
    expect(differsFrom(current, change({ status: 'past_due' }))).toBe(true);
    expect(differsFrom(current, change({ planCode: 'scale' }))).toBe(true);
    expect(differsFrom(current, change({ platformPlanId: 'other' }))).toBe(true);
    expect(differsFrom(current, change({ currentPeriodStart: at('2026-02-01T00:00:00.000Z') }))).toBe(true);
    expect(differsFrom(current, change({ currentPeriodEnd: at('2026-05-01T00:00:00.000Z') }))).toBe(true);
    expect(differsFrom(current, change({ trialEndsAt: at('2026-05-01T00:00:00.000Z') }))).toBe(true);
  });

  it('ignores fields the platform did not report', () => {
    // A poll that omits the plan is not a claim that the plan is null.
    expect(differsFrom(subscription(), change({ status: 'active' }))).toBe(false);
  });
});
