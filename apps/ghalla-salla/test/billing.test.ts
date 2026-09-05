import 'reflect-metadata';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { toInstant } from '@ghalla/contracts';
import type { Instant, StoreId } from '@ghalla/contracts';
import { PLANS, UsageCache } from '@ghalla/billing';
import type { Subscription, UsageWindow } from '@ghalla/billing';
import type { BillingEvent, PlatformSubscription, SubscriptionFacts } from '@ghalla/ports';
import { BillingEventHandler } from '../src/billing/billing-event.handler.js';
import { BillingMetrics } from '../src/billing/billing.metrics.js';
import { EntitlementsService } from '../src/billing/entitlements.service.js';
import { EntitlementsGuard } from '../src/billing/entitlements.guard.js';
import type { BillingRequest } from '../src/billing/entitlements.guard.js';
import { ReconciliationService } from '../src/billing/reconciliation.service.js';
import { SubscriptionRefreshService } from '../src/billing/subscription-refresh.service.js';
import type { SubscriptionSource } from '../src/billing/subscription-source.js';
import {
  EntitlementDeniedException,
  SubscriptionInactiveException,
} from '../src/billing/entitlement-denied.exception.js';
import { REQUIRES_FEATURE, RequiresFeature } from '../src/billing/requires-feature.decorator.js';

const STORE = 'demo:1' as StoreId;
const at = (iso: string): Instant => toInstant(iso);
const NOW = at('2026-03-15T00:00:00.000Z');

/**
 * An in-memory stand-in for the repository.
 *
 * The repository's own behaviour is tested against a real Postgres in
 * `packages/persistence`. What is under test here is what the SERVICES conclude
 * from what it returns, so a fake keeps these tests about that and nothing else.
 */
class FakeRepo {
  rows = new Map<string, Subscription>();
  orders = 0;
  countCalls = 0;
  saved: Subscription[] = [];

  find(storeId: StoreId): Promise<Subscription | null> {
    return Promise.resolve(this.rows.get(storeId) ?? null);
  }

  save(subscription: Subscription): Promise<void> {
    this.rows.set(subscription.storeId, subscription);
    this.saved.push(subscription);
    return Promise.resolve();
  }

  countLiveOrders(_storeId: StoreId, _window: UsageWindow): Promise<number> {
    this.countCalls += 1;
    return Promise.resolve(this.orders);
  }

  dueForReconciliation(limit: number): Promise<readonly Subscription[]> {
    return Promise.resolve([...this.rows.values()].slice(0, limit));
  }

  markReconciled(storeId: StoreId, at_: Instant): Promise<void> {
    const row = this.rows.get(storeId);
    if (row !== undefined) this.rows.set(storeId, { ...row, lastReconciledAt: at_ });
    return Promise.resolve();
  }

  dueMarked: string[] = [];

  markDueForReconciliation(storeId: StoreId): Promise<void> {
    this.dueMarked.push(storeId);
    const row = this.rows.get(storeId);
    if (row !== undefined) this.rows.set(storeId, { ...row, lastReconciledAt: null });
    return Promise.resolve();
  }
}

type Repo = ConstructorParameters<typeof BillingEventHandler>[0];

const subscription = (over: Partial<Subscription> = {}): Subscription => ({
  storeId: STORE,
  planCode: 'starter',
  platformPlanId: 'plat_1',
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

const facts = (over: Partial<SubscriptionFacts> = {}): SubscriptionFacts => ({
  status: 'active',
  planCode: 'growth',
  platformPlanId: 'plat_2',
  trialEndsAt: null,
  currentPeriodStart: at('2026-03-01T00:00:00.000Z'),
  currentPeriodEnd: at('2026-04-01T00:00:00.000Z'),
  ...over,
});

const event = (over: Partial<BillingEvent> = {}): BillingEvent => ({
  type: 'subscription_renewed',
  rawType: 'app.subscription.renewed',
  dedupeKey: 'evt_1',
  platformStoreId: '1',
  occurredAt: at('2026-03-12T00:00:00.000Z'),
  receivedAt: at('2026-03-12T00:00:10.000Z'),
  facts: facts(),
  ...over,
});

let repo: FakeRepo;
let metrics: BillingMetrics;

beforeEach(() => {
  repo = new FakeRepo();
  metrics = new BillingMetrics();
  vi.spyOn(metrics['logger'], 'warn').mockImplementation(() => undefined);
  vi.spyOn(metrics['logger'], 'error').mockImplementation(() => undefined);
  vi.spyOn(metrics['logger'], 'log').mockImplementation(() => undefined);
});

const handler = (): BillingEventHandler => new BillingEventHandler(repo as unknown as Repo, metrics);

describe('handling a billing webhook', () => {
  it('creates the row from the first event a store ever sends', async () => {
    const result = await handler().handle(STORE, event({ type: 'subscription_started' }));
    expect(result.kind).toBe('applied');
    if (result.kind !== 'applied') return;
    // Built from the event, not from a default: a store that installs straight
    // onto a paid plan must not be briefly recorded as trialing.
    expect(result.subscription.status).toBe('active');
    expect(result.subscription.planCode).toBe('growth');
    expect(result.subscription.lastEventAt).toBe(at('2026-03-12T00:00:00.000Z'));
  });

  it('drops a cancellation that was issued before the renewal we already have', async () => {
    // The headline case. Salla delivers out of order; applying this locks out a
    // merchant whose card was charged two days ago.
    repo.rows.set(STORE, subscription({ status: 'active', lastEventAt: at('2026-03-10T00:00:00.000Z') }));

    const result = await handler().handle(
      STORE,
      event({
        type: 'subscription_cancelled',
        occurredAt: at('2026-03-05T00:00:00.000Z'),
        facts: facts({ status: 'canceled' }),
      }),
    );

    expect(result.kind).toBe('dropped_stale');
    expect(repo.rows.get(STORE)?.status).toBe('active');
    expect(metrics.snapshot()['events.dropped_stale.subscription_cancelled']).toBe(1);
  });

  it('is idempotent across a duplicate delivery', async () => {
    // At-least-once delivery is normal. The second copy must change nothing —
    // and must not be counted as a processed event twice, or the received/
    // processed ratio stops meaning anything.
    const h = handler();
    const first = await h.handle(STORE, event({ type: 'subscription_started' }));
    const second = await h.handle(STORE, event({ type: 'subscription_started' }));

    expect(first.kind).toBe('applied');
    expect(second.kind).toBe('dropped_stale');
    expect(repo.saved).toHaveLength(1);
  });

  it('records an event type it does not model without guessing at it', async () => {
    // A platform adds event types without telling us. Guessing at one turns a
    // feature announcement into a subscription status nobody intended.
    repo.rows.set(STORE, subscription());
    const result = await handler().handle(STORE, event({ type: 'unknown', rawType: 'app.mystery' }));
    expect(result.kind).toBe('ignored');
    expect(repo.saved).toHaveLength(0);
    expect(metrics.snapshot()['events.received.unknown']).toBe(1);
  });

  it('keeps the last good plan when the adapter sends one we cannot resolve', async () => {
    // Better than writing a code no build can resolve. Surfaced as a metric,
    // because it means the adapter's plan mapping has a gap.
    repo.rows.set(STORE, subscription({ planCode: 'growth' }));
    const result = await handler().handle(
      STORE,
      event({ facts: facts({ planCode: 'mystery_tier' }) }),
    );
    expect(result.kind).toBe('applied');
    if (result.kind !== 'applied') return;
    expect(result.subscription.planCode).toBe('growth');
    expect(metrics.snapshot()['plan.unknown']).toBe(1);
  });

  it('counts a trial converting to paid', async () => {
    repo.rows.set(STORE, subscription({ status: 'trialing', lastEventAt: at('2026-03-01T00:00:00.000Z') }));
    await handler().handle(STORE, event({ type: 'subscription_started' }));
    expect(metrics.snapshot()['trial.converted.growth']).toBe(1);
  });

  it('counts a trial ending', async () => {
    repo.rows.set(STORE, subscription({ status: 'trialing', lastEventAt: at('2026-03-01T00:00:00.000Z') }));
    await handler().handle(
      STORE,
      event({ type: 'trial_ended', facts: facts({ status: 'expired' }) }),
    );
    expect(metrics.snapshot()['trial.expired']).toBe(1);
  });

  it('seeds a store onto the trial plan when the first event names no plan we know', async () => {
    // An install whose plan mapping is not configured yet. Falling back to the
    // trial plan gives the merchant a working dashboard; writing an unresolvable
    // code would give them the fail-closed starter fallback on every request
    // and no way to tell why.
    const result = await handler().handle(
      STORE,
      event({ type: 'subscription_started', facts: facts({ planCode: null }) }),
    );
    expect(result.kind).toBe('applied');
    if (result.kind !== 'applied') return;
    expect(result.subscription.planCode).toBe('growth');
  });

  it('seeds a period when the event carries none, rather than failing the write', async () => {
    // The CHECK requires end > start, so a zero interval would be rejected and
    // the store would end up with no row at all.
    const result = await handler().handle(
      STORE,
      event({
        type: 'subscription_started',
        facts: facts({ currentPeriodStart: null, currentPeriodEnd: null }),
      }),
    );
    expect(result.kind).toBe('applied');
    if (result.kind !== 'applied') return;
    expect(new Date(result.subscription.currentPeriodEnd).getTime()).toBeGreaterThan(
      new Date(result.subscription.currentPeriodStart).getTime(),
    );
  });
});

describe('asking the platform about one store', () => {
  const sourceReturning = (value: PlatformSubscription | null): SubscriptionSource => ({
    fetch: () => Promise.resolve(value),
  });

  const platform = (over: Partial<SubscriptionFacts> = {}): PlatformSubscription => ({
    facts: facts(over),
    isDevelopmentStore: false,
    observedAt: at('2026-03-31T03:00:00.000Z'),
  });

  const refresher = (source: SubscriptionSource | null): SubscriptionRefreshService => {
    const s = new SubscriptionRefreshService(repo as never, metrics, source);
    vi.spyOn(s as unknown as { nowInstant: () => Instant }, 'nowInstant').mockReturnValue(
      at('2026-03-31T03:00:00.000Z'),
    );
    vi.spyOn(s['logger'], 'warn').mockImplementation(() => undefined);
    vi.spyOn(s['logger'], 'error').mockImplementation(() => undefined);
    return s;
  };

  it('creates the row for a store that has none — the install path', async () => {
    // Without this, a store whose install webhook was lost sits on a
    // provisional trial for ever: nothing else ever creates its row, because
    // the nightly sweep only walks rows that already exist.
    const result = await refresher(sourceReturning(platform())).refreshNow(STORE);
    expect(result.kind).toBe('created');
    expect(repo.rows.get(STORE)?.planCode).toBe('growth');
    // Stamped as checked, so the sweep does not immediately re-fetch it.
    expect(repo.rows.get(STORE)?.lastReconciledAt).not.toBeNull();
  });

  it('corrects a row the webhooks got wrong', async () => {
    // THE reason any of this exists. Webhooks get dropped, and treating them as
    // the sole source of truth guarantees someone eventually loses access they
    // paid for — discovered by them, not by us.
    repo.rows.set(STORE, subscription({ status: 'canceled' }));
    const result = await refresher(sourceReturning(platform({ status: 'active' }))).refreshNow(STORE);
    expect(result).toStrictEqual({ kind: 'corrected', from: 'canceled', to: 'active' });
    expect(repo.rows.get(STORE)?.status).toBe('active');
    expect(metrics.snapshot()['reconciliation.corrections']).toBe(1);
  });

  it('writes nothing when the platform agrees', async () => {
    // The correction count is only a signal if its baseline is silence.
    repo.rows.set(STORE, subscription({ status: 'active', planCode: 'growth', platformPlanId: 'plat_2' }));
    const result = await refresher(sourceReturning(platform())).refreshNow(STORE);
    expect(result.kind).toBe('unchanged');
    expect(repo.saved).toHaveLength(0);
    expect(repo.rows.get(STORE)?.lastReconciledAt).not.toBeNull();
  });

  it('does not revoke access when the platform returns nothing', async () => {
    // A null answer is a transient API fault as often as it is an uninstall,
    // and one of those two is a paying customer.
    repo.rows.set(STORE, subscription({ status: 'active' }));
    const result = await refresher(sourceReturning(null)).refreshNow(STORE);
    expect(result.kind).toBe('unrecognised');
    expect(repo.rows.get(STORE)?.status).toBe('active');
  });

  it('reports unrecognised without writing when there was no row either', async () => {
    const result = await refresher(sourceReturning(null)).refreshNow(STORE);
    expect(result.kind).toBe('unrecognised');
    expect(repo.saved).toHaveLength(0);
  });

  it('reports unavailable rather than pretending it found no drift', async () => {
    // A component that silently does nothing is indistinguishable from one that
    // found nothing wrong, and those are opposite situations.
    const result = await refresher(null).refreshNow(STORE);
    expect(result.kind).toBe('unavailable');
  });

  it('ignores a plan code this build cannot resolve', async () => {
    // Same rule as the webhook path: keep the last good plan rather than write
    // a code no build can resolve.
    repo.rows.set(STORE, subscription({ planCode: 'growth', status: 'canceled' }));
    await refresher(sourceReturning(platform({ status: 'active', planCode: 'mystery' }))).refreshNow(STORE);
    expect(repo.rows.get(STORE)?.planCode).toBe('growth');
    expect(repo.rows.get(STORE)?.status).toBe('active');
  });

  it('reports a failure rather than throwing at its caller', async () => {
    repo.rows.set(STORE, subscription());
    const result = await refresher({
      fetch: () => Promise.reject(new Error('401 from the platform')),
    }).refreshNow(STORE);
    expect(result).toStrictEqual({ kind: 'failed', error: '401 from the platform' });
    expect(metrics.snapshot()['reconciliation.failures']).toBe(1);
  });

  it('records a failure that was not thrown as an Error', async () => {
    // A driver rejecting with a string, or a platform SDK throwing a plain
    // object. `error.message` on those is undefined, and an undefined reason in
    // the failure log is how a recurring outage becomes invisible.
    repo.rows.set(STORE, subscription());
    const result = await refresher({ fetch: () => Promise.reject('rate limited') }).refreshNow(STORE);
    expect(result).toStrictEqual({ kind: 'failed', error: 'rate limited' });
  });

  it('collapses two simultaneous refreshes into one call', async () => {
    // A merchant double-clicking, or an install racing the first webhook. Two
    // writes landing out of order is the failure; one fetch is the fix.
    let calls = 0;
    const counting: SubscriptionSource = {
      fetch: () => {
        calls += 1;
        return Promise.resolve(platform());
      },
    };
    const service = refresher(counting);
    const [a, b] = await Promise.all([service.refreshNow(STORE), service.refreshNow(STORE)]);
    expect(calls).toBe(1);
    expect(a).toStrictEqual(b);
  });

  it('lets a later refresh through once the first has finished', async () => {
    let calls = 0;
    const counting: SubscriptionSource = {
      fetch: () => {
        calls += 1;
        return Promise.resolve(platform());
      },
    };
    const service = refresher(counting);
    await service.refreshNow(STORE);
    await service.refreshNow(STORE);
    expect(calls).toBe(2);
  });
});

describe('a merchant asking for a refresh', () => {
  const platform = (): PlatformSubscription => ({
    facts: facts({ status: 'active' }),
    isDevelopmentStore: false,
    observedAt: at('2026-03-31T03:00:00.000Z'),
  });

  const refresher = (
    source: SubscriptionSource | null,
    now = at('2026-03-31T03:00:00.000Z'),
  ): SubscriptionRefreshService => {
    const s = new SubscriptionRefreshService(repo as never, metrics, source);
    vi.spyOn(s as unknown as { nowInstant: () => Instant }, 'nowInstant').mockReturnValue(now);
    vi.spyOn(s['logger'], 'warn').mockImplementation(() => undefined);
    vi.spyOn(s['logger'], 'error').mockImplementation(() => undefined);
    return s;
  };

  it('returns immediately and does the work in the background', async () => {
    // The whole point. A dashboard that hangs while we talk to a third party is
    // what the local-table-is-truth rule exists to prevent.
    repo.rows.set(STORE, subscription({ status: 'canceled', lastReconciledAt: null }));
    const service = refresher({ fetch: () => Promise.resolve(platform()) });

    expect(await service.requestRefresh(STORE)).toStrictEqual({ kind: 'started' });
    await service.settled();
    expect(repo.rows.get(STORE)?.status).toBe('active');
  });

  it('marks the store due before starting, so the request survives a restart', async () => {
    // The row IS the queue. If this process dies between the request and the
    // fetch, the nightly sweep picks the store up first — it orders NULLS
    // FIRST.
    repo.rows.set(STORE, subscription({ lastReconciledAt: at('2026-03-30T00:00:00.000Z') }));
    const service = refresher({ fetch: () => new Promise(() => undefined) });
    await service.requestRefresh(STORE);
    expect(repo.dueMarked).toContain(STORE);
  });

  it('refuses to hammer the platform when asked repeatedly', async () => {
    // Holding the button down must not become a way to earn a rate-limit ban
    // for every other store.
    repo.rows.set(STORE, subscription({ lastReconciledAt: at('2026-03-31T02:59:30.000Z') }));
    const service = refresher({ fetch: () => Promise.resolve(platform()) });

    const outcome = await service.requestRefresh(STORE);
    expect(outcome.kind).toBe('throttled');
    if (outcome.kind === 'throttled') expect(outcome.lastCheckedAt).toBe(at('2026-03-31T02:59:30.000Z'));
    expect(repo.dueMarked).toHaveLength(0);
  });

  it('allows it again once the throttle window has passed', async () => {
    repo.rows.set(STORE, subscription({ lastReconciledAt: at('2026-03-31T02:50:00.000Z') }));
    const service = refresher({ fetch: () => Promise.resolve(platform()) });
    expect((await service.requestRefresh(STORE)).kind).toBe('started');
    await service.settled();
  });

  it('works for a store that has never been checked', async () => {
    repo.rows.set(STORE, subscription({ lastReconciledAt: null }));
    const service = refresher({ fetch: () => Promise.resolve(platform()) });
    expect((await service.requestRefresh(STORE)).kind).toBe('started');
    await service.settled();
  });

  it('works for a store that has no row at all', async () => {
    // The install-shaped case: nothing to mark due, because there is nothing to
    // mark. The fetch still runs and creates the row.
    const service = refresher({ fetch: () => Promise.resolve(platform()) });
    expect((await service.requestRefresh(STORE)).kind).toBe('started');
    await service.settled();
    expect(repo.dueMarked).toHaveLength(0);
    expect(repo.rows.get(STORE)).toBeDefined();
  });

  it('says so when no source is wired instead of queueing forever', async () => {
    expect(await refresher(null).requestRefresh(STORE)).toStrictEqual({ kind: 'unavailable' });
  });

  it('does not take the process down when the source throws synchronously', async () => {
    // `requestRefresh` starts the work and does NOT await it, so an unhandled
    // rejection here would end the container. This asserts the totality that
    // makes voiding the promise safe: refreshNow resolves to `failed` rather
    // than rejecting, whatever the source does.
    repo.rows.set(STORE, subscription({ lastReconciledAt: null }));
    const service = refresher({
      fetch: () => {
        throw new Error('synchronous explosion');
      },
    });
    await expect(service.refreshNow(STORE)).resolves.toStrictEqual({
      kind: 'failed',
      error: 'synchronous explosion',
    });

    expect((await service.requestRefresh(STORE)).kind).toBe('started');
    await expect(service.settled()).resolves.toBeUndefined();
  });
});

describe('provisioning at install', () => {
  it('writes the real subscription so a lost webhook does not strand the store', async () => {
    const service = new SubscriptionRefreshService(repo as never, metrics, {
      fetch: () =>
        Promise.resolve({
          facts: facts({ status: 'active', planCode: 'scale' }),
          isDevelopmentStore: false,
          observedAt: at('2026-03-31T03:00:00.000Z'),
        }),
    });
    vi.spyOn(service['logger'], 'warn').mockImplementation(() => undefined);

    const result = await service.provisionAtInstall(STORE);
    expect(result.kind).toBe('created');
    expect(repo.rows.get(STORE)?.planCode).toBe('scale');
  });

  it('leaves the store on a provisional trial when the platform cannot be reached', async () => {
    // Recoverable: the merchant gets a working dashboard, the nightly sweep
    // fixes the row, and nobody is shown a payment wall on their first load.
    const service = new SubscriptionRefreshService(repo as never, metrics, {
      fetch: () => Promise.reject(new Error('timeout')),
    });
    vi.spyOn(service['logger'], 'warn').mockImplementation(() => undefined);

    expect((await service.provisionAtInstall(STORE)).kind).toBe('failed');
    expect(repo.rows.get(STORE)).toBeUndefined();
  });

  it('says so when no source is wired', async () => {
    const service = new SubscriptionRefreshService(repo as never, metrics, null);
    vi.spyOn(service['logger'], 'warn').mockImplementation(() => undefined);
    expect((await service.provisionAtInstall(STORE)).kind).toBe('unavailable');
  });
});

describe('the nightly sweep', () => {
  const sweeper = (source: SubscriptionSource | null): ReconciliationService => {
    const refresh = new SubscriptionRefreshService(repo as never, metrics, source);
    vi.spyOn(refresh as unknown as { nowInstant: () => Instant }, 'nowInstant').mockReturnValue(
      at('2026-03-31T03:00:00.000Z'),
    );
    vi.spyOn(refresh['logger'], 'warn').mockImplementation(() => undefined);
    const service = new ReconciliationService(repo as never, refresh);
    vi.spyOn(service['logger'], 'warn').mockImplementation(() => undefined);
    vi.spyOn(service['logger'], 'log').mockImplementation(() => undefined);
    return service;
  };

  const platform = (over: Partial<SubscriptionFacts> = {}): PlatformSubscription => ({
    facts: facts(over),
    isDevelopmentStore: false,
    observedAt: at('2026-03-31T03:00:00.000Z'),
  });

  it('tallies what it did', async () => {
    repo.rows.set(STORE, subscription({ status: 'canceled' }));
    repo.rows.set('demo:2' as StoreId, subscription({ storeId: 'demo:2' as StoreId, status: 'canceled' }));

    const summary = await sweeper({ fetch: () => Promise.resolve(platform({ status: 'active' })) }).runOnce(10);
    expect(summary).toStrictEqual({ checked: 2, created: 0, corrected: 2, failed: 0, skipped: 0 });
  });

  it('steps over a store that throws and keeps going', async () => {
    // One store whose credentials have been revoked must not stop the other
    // four hundred from being checked.
    repo.rows.set(STORE, subscription());
    repo.rows.set('demo:2' as StoreId, subscription({ storeId: 'demo:2' as StoreId, status: 'canceled' }));

    let call = 0;
    const summary = await sweeper({
      fetch: () => {
        call += 1;
        if (call === 1) return Promise.reject(new Error('401'));
        return Promise.resolve(platform({ status: 'active' }));
      },
    }).runOnce(10);

    expect(summary.checked).toBe(2);
    expect(summary.failed).toBe(1);
    expect(summary.corrected).toBe(1);
  });

  it('counts a store the platform does not recognise as skipped, not corrected', async () => {
    repo.rows.set(STORE, subscription());
    const summary = await sweeper({ fetch: () => Promise.resolve(null) }).runOnce(10);
    expect(summary.skipped).toBe(1);
    expect(summary.corrected).toBe(0);
  });

  it('reports a whole pass that checked nothing', async () => {
    // Distinguishable on a dashboard from `checked: 400, corrected: 0`, which
    // is the entire point.
    repo.rows.set(STORE, subscription());
    const summary = await sweeper(null).runOnce(10);
    expect(summary).toStrictEqual({ checked: 1, created: 0, corrected: 0, failed: 0, skipped: 1 });
  });

  it('does nothing quietly when there are no stores at all', async () => {
    const summary = await sweeper(null).runOnce(10);
    expect(summary.checked).toBe(0);
  });

  it('runs a pass from the nightly schedule', async () => {
    await expect(sweeper(null).runNightly()).resolves.toBeUndefined();
  });
});

describe('resolving a store’s billing on a request', () => {
  const service = (): EntitlementsService => {
    const s = new EntitlementsService(repo as never, new UsageCache(300_000), metrics);
    vi.spyOn(s as unknown as { nowInstant: () => Instant }, 'nowInstant').mockReturnValue(NOW);
    return s;
  };

  it('treats a store with no row as a trial rather than a payment wall', async () => {
    // The window between an install completing and its first billing webhook
    // is seconds — but a merchant clicking through onboarding will hit it, and
    // the first thing they should see is not a paywall.
    const result = await service().describe(STORE);
    expect(result.subscription.status).toBe('trialing');
    expect(result.entitlements.access.dashboard).toBe('full');
  });

  it('reads the count once and serves the rest from cache', async () => {
    repo.rows.set(STORE, subscription());
    repo.orders = 42;
    const s = service();
    await s.describe(STORE);
    await s.describe(STORE);
    expect(repo.countCalls).toBe(1);
  });

  it('flags a store over its cap without touching its access', async () => {
    repo.rows.set(STORE, subscription({ planCode: 'starter' }));
    repo.orders = PLANS.starter.orderCap + 1;

    const result = await service().describe(STORE);
    expect(result.usage.overCap).toBe(true);
    expect(result.entitlements.access.notice).toBe('over_order_cap');
    // The point of the whole design: the pipeline does not stop.
    expect(result.entitlements.access.ingestion).toBe('running');
    expect(metrics.snapshot()['usage.over_cap.starter']).toBe(1);
  });

  it('applies a mid-period upgrade on the very next request, with no invalidation', async () => {
    // The cached value is the COUNT, which a plan change does not affect. The
    // cap comes from the subscription row every time, so an upgrade takes
    // effect immediately — no invalidation call, and no five-minute wait.
    repo.rows.set(STORE, subscription({ planCode: 'starter' }));
    repo.orders = 400;
    const s = service();

    const before = await s.describe(STORE);
    expect(before.usage.overCap).toBe(true);

    repo.rows.set(STORE, subscription({ planCode: 'growth' }));
    const after = await s.describe(STORE);

    expect(after.usage.overCap).toBe(false);
    expect(after.usage.cap).toBe(PLANS.growth.orderCap);
    // And it did NOT re-count: the cached number was still correct.
    expect(repo.countCalls).toBe(1);
  });

  it('reads the real clock when nothing pins it', async () => {
    // Every other test here mocks the clock to sit on a boundary. This one does
    // not, because a service whose only exercised path is the mocked one is a
    // service nobody has run.
    repo.rows.set(STORE, subscription({
      currentPeriodStart: at('2020-01-01T00:00:00.000Z'),
      currentPeriodEnd: at('2099-01-01T00:00:00.000Z'),
    }));
    const live = new EntitlementsService(repo as never, new UsageCache(), metrics);
    const result = await live.describe(STORE);
    expect(result.entitlements.access.dashboard).toBe('full');
  });

  it('reports a plan this build cannot resolve', async () => {
    repo.rows.set(STORE, subscription({ planCode: 'legacy_tier' }));
    const result = await service().describe(STORE);
    expect(result.entitlements.planUnknown).toBe(true);
    expect(metrics.snapshot()['plan.unknown']).toBe(1);
  });
});

describe('the entitlements guard', () => {
  const contextFor = (request: BillingRequest, required: string | undefined): never =>
    ({
      switchToHttp: () => ({ getRequest: () => request }),
      getHandler: () => undefined,
      getClass: () => undefined,
      // Carried so each call site reads as "this route requires X", even though
      // the fake reflector below is what actually supplies it.
      _required: required,
    }) as never;

  const guardWith = (required: string | undefined, entitlementsService: EntitlementsService): EntitlementsGuard =>
    new EntitlementsGuard(
      { getAllAndOverride: () => required } as never,
      entitlementsService,
    );

  const serviceFor = (over: Partial<Subscription>): EntitlementsService => {
    repo.rows.set(STORE, subscription(over));
    const s = new EntitlementsService(repo as never, new UsageCache(), metrics);
    vi.spyOn(s as unknown as { nowInstant: () => Instant }, 'nowInstant').mockReturnValue(NOW);
    return s;
  };

  it('lets an unauthenticated route through untouched', async () => {
    // Health has no store. Inventing a denial here would break every route that
    // is not store-scoped.
    const guard = guardWith('attribution', serviceFor({}));
    await expect(guard.canActivate(contextFor({}, 'attribution'))).resolves.toBe(true);
  });

  it('resolves entitlements onto the request, once', async () => {
    // What stops plan checks from spreading into services: everything
    // downstream reads this object instead of asking again.
    const request: BillingRequest = { storeId: STORE };
    const guard = guardWith(undefined, serviceFor({ planCode: 'growth' }));
    await guard.canActivate(contextFor(request, undefined));
    expect(request.entitlements?.planCode).toBe('growth');
  });

  it('allows a route whose feature the plan includes', async () => {
    const guard = guardWith('attribution', serviceFor({ planCode: 'ads' }));
    await expect(guard.canActivate(contextFor({ storeId: STORE }, 'attribution'))).resolves.toBe(true);
  });

  it('denies with the plan the merchant needs to buy', async () => {
    // A bare 403 makes them guess. Naming the tier turns a dead end into a
    // checkout link — 402, not 403, so the frontend shows an upgrade screen
    // rather than prompting a support ticket.
    const guard = guardWith('attribution', serviceFor({ planCode: 'starter' }));
    await expect(guard.canActivate(contextFor({ storeId: STORE }, 'attribution'))).rejects.toThrow(
      EntitlementDeniedException,
    );

    try {
      await guard.canActivate(contextFor({ storeId: STORE }, 'attribution'));
    } catch (error) {
      const body = (error as EntitlementDeniedException).getResponse() as Record<string, unknown>;
      expect(body['error']).toBe('entitlement_required');
      expect(body['feature']).toBe('attribution');
      expect(body['currentPlan']).toBe('starter');
      // `null`, because the only plan carrying `attribution` is not for sale:
      // its features are not built. Naming it would send the merchant to a
      // checkout that does not exist for a feature that would not arrive.
      expect(body['requiredPlan']).toBeNull();
      expect((error as EntitlementDeniedException).getStatus()).toBe(402);
    }
  });

  it('refuses a canceled store before it considers the feature at all', async () => {
    // "Your subscription ended" and "that needs a bigger plan" are different
    // messages, and showing the second to somebody who cancelled is nonsense.
    const guard = guardWith('attribution', serviceFor({ status: 'canceled', planCode: 'ads' }));
    await expect(guard.canActivate(contextFor({ storeId: STORE }, 'attribution'))).rejects.toThrow(
      SubscriptionInactiveException,
    );
  });

  it('lets a past_due merchant straight through', async () => {
    // Payment retries frequently succeed. This is the one that would quietly
    // cost customers if it were wrong.
    const guard = guardWith('core', serviceFor({ status: 'past_due' }));
    await expect(guard.canActivate(contextFor({ storeId: STORE }, 'core'))).resolves.toBe(true);
  });

  it('names no plan when the feature exists on none', async () => {
    const guard = guardWith('telepathy', serviceFor({ planCode: 'starter' }));
    try {
      await guard.canActivate(contextFor({ storeId: STORE }, 'telepathy'));
      expect.unreachable('should have denied');
    } catch (error) {
      const body = (error as EntitlementDeniedException).getResponse() as Record<string, unknown>;
      expect(body['requiredPlan']).toBeNull();
      expect(String(body['message'])).toContain('not available on any current plan');
    }
  });
});

describe('the @RequiresFeature decorator', () => {
  it('attaches the feature to the handler as metadata the guard reads', () => {
    // The gate is declarative and this is the whole mechanism: the requirement
    // sits one line above the method, where a reviewer reading the route sees
    // it, instead of an `if (plan === …)` buried in a service.
    // Applied as a function rather than with `@` syntax: the factory is what is
    // under test, and decorator syntax in a test file only exercises the
    // transform.
    class Campaigns {
      getCampaigns(): string {
        return 'ok';
      }
    }
    const descriptor = Object.getOwnPropertyDescriptor(Campaigns.prototype, 'getCampaigns');
    expect(descriptor).toBeDefined();
    if (descriptor === undefined) return;
    (RequiresFeature('attribution') as MethodDecorator)(
      Campaigns.prototype,
      'getCampaigns',
      descriptor,
    );

    expect(Reflect.getMetadata(REQUIRES_FEATURE, Campaigns.prototype.getCampaigns)).toBe('attribution');
  });
});

describe('the billing metrics surface', () => {
  it('counts what it is asked to count', () => {
    metrics.eventReceived('subscription_renewed');
    metrics.eventProcessed('subscription_renewed');
    metrics.eventUnmatched('subscription_renewed', 'store_9');
    metrics.entitlementDenied('attribution', 'starter');
    expect(metrics.snapshot()).toMatchObject({
      'events.received.subscription_renewed': 1,
      'events.processed.subscription_renewed': 1,
      'events.unmatched.subscription_renewed': 1,
      'entitlement.denied.attribution': 1,
    });
  });
});
