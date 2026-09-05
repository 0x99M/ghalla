import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { toInstant } from '@ghalla/contracts';
import type { Instant, StoreId } from '@ghalla/contracts';
import { isPlanCode, reconcile, seedSubscription } from '@ghalla/billing';
import type { SubscriptionChange } from '@ghalla/billing';
import type { PlatformSubscription } from '@ghalla/ports';
import { SubscriptionRepository } from '@ghalla/persistence';
import { BillingMetrics } from './billing.metrics.js';
import { SUBSCRIPTION_SOURCE } from './subscription-source.js';
import type { SubscriptionSource } from './subscription-source.js';

/**
 * What one refresh did.
 *
 * Distinct outcomes rather than a boolean, because the caller's next move
 * differs for each and because the nightly sweep tallies them into the numbers
 * that say whether the webhook path is healthy.
 */
export type RefreshResult =
  /** No row existed; the platform's answer became one. The install path. */
  | { readonly kind: 'created' }
  /** The platform disagreed with us and won. */
  | { readonly kind: 'corrected'; readonly from: string; readonly to: string }
  /** The platform agrees. The normal, boring answer. */
  | { readonly kind: 'unchanged' }
  /** The platform does not know this store. */
  | { readonly kind: 'unrecognised' }
  /** No source is wired yet. */
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'failed'; readonly error: string };

export type RefreshRequest =
  | { readonly kind: 'started' }
  /** Already checked within the throttle window; the answer would be the same. */
  | { readonly kind: 'throttled'; readonly lastCheckedAt: Instant }
  | { readonly kind: 'unavailable' };

/**
 * How recently a store must have been checked for a manual refresh to be a
 * no-op.
 *
 * Short enough that a merchant who upgrades and clicks refresh gets an answer,
 * long enough that holding the button down does not become a way to make us
 * hammer the platform's API on a merchant's behalf and earn a rate-limit ban
 * for every other store.
 */
const REFRESH_THROTTLE_MS = 60_000;

/**
 * Fetching the platform's answer for ONE store, and writing it down.
 *
 * Three callers, one path, deliberately: the install handshake, a merchant
 * asking for a refresh, and the nightly sweep. Two implementations of "ask the
 * platform and reconcile" would drift, and the drift would surface as "the
 * reconciler says one thing and the install said another" on stores nobody can
 * reproduce.
 *
 * NEVER called synchronously from a request path. `requestRefresh` starts the
 * work and returns; the merchant's next page load reads the row. Blocking a
 * dashboard render on a third party's API is what the local-table-is-truth rule
 * exists to prevent.
 */
@Injectable()
export class SubscriptionRefreshService {
  private readonly logger = new Logger(SubscriptionRefreshService.name);

  /**
   * Refreshes already running, by store.
   *
   * Deduplication first and test convenience second: a merchant double-clicking
   * refresh, or an install racing the first webhook, must produce one call to
   * the platform rather than two writes that can land out of order.
   */
  private readonly inFlight = new Map<string, Promise<RefreshResult>>();

  constructor(
    private readonly subscriptions: SubscriptionRepository,
    private readonly metrics: BillingMetrics,
    @Optional() @Inject(SUBSCRIPTION_SOURCE) private readonly source: SubscriptionSource | null = null,
  ) {}

  protected nowInstant(): Instant {
    return toInstant(new Date().toISOString());
  }

  private static toChange(truth: PlatformSubscription): SubscriptionChange {
    return {
      status: truth.facts.status,
      // Validated, not trusted — same rule as the webhook path. An adapter that
      // cannot map a platform plan id sends null, which means "did not say" and
      // preserves whatever the row already had.
      planCode:
        truth.facts.planCode !== null && isPlanCode(truth.facts.planCode) ? truth.facts.planCode : null,
      platformPlanId: truth.facts.platformPlanId,
      trialEndsAt: truth.facts.trialEndsAt,
      currentPeriodStart: truth.facts.currentPeriodStart,
      currentPeriodEnd: truth.facts.currentPeriodEnd,
      occurredAt: truth.observedAt,
    };
  }

  /**
   * Ask the platform about one store and write down the answer.
   *
   * Awaited by the nightly sweep and by the install handshake. A merchant's
   * refresh button goes through `requestRefresh` instead, which does not wait.
   */
  async refreshNow(storeId: StoreId): Promise<RefreshResult> {
    const existing = this.inFlight.get(storeId);
    if (existing !== undefined) return existing;

    const run = this.performRefresh(storeId).finally(() => {
      this.inFlight.delete(storeId);
    });
    this.inFlight.set(storeId, run);
    return run;
  }

  private async performRefresh(storeId: StoreId): Promise<RefreshResult> {
    if (this.source === null) return { kind: 'unavailable' };
    const at = this.nowInstant();

    try {
      const truth = await this.source.fetch(storeId);
      const current = await this.subscriptions.find(storeId);

      if (truth === null) {
        // The platform does not recognise this store — usually an uninstall
        // whose webhook we missed. NOT auto-cancelled: revoking access on a
        // null answer makes a transient API fault indistinguishable from an
        // uninstall, and one of those is a paying customer.
        this.logger.warn({ message: 'platform returned no subscription for this store', storeId });
        if (current !== null) await this.subscriptions.markReconciled(storeId, at);
        return { kind: 'unrecognised' };
      }

      const change = SubscriptionRefreshService.toChange(truth);

      if (current === null) {
        // The install path. A store whose billing webhook was lost would
        // otherwise sit on a provisional trial for ever.
        const seeded = { ...seedSubscription(storeId, change), lastReconciledAt: at };
        await this.subscriptions.save(seeded, at);
        this.metrics.reconciliationChecked();
        return { kind: 'created' };
      }

      const outcome = reconcile(current, change, at);
      this.metrics.reconciliationChecked();

      if (outcome.kind === 'unchanged') {
        await this.subscriptions.markReconciled(storeId, at);
        return { kind: 'unchanged' };
      }

      await this.subscriptions.save(outcome.next, at);
      this.metrics.reconciliationCorrection(storeId, current.status, outcome.next.status);
      return { kind: 'corrected', from: current.status, to: outcome.next.status };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.metrics.reconciliationFailed(storeId, message);
      return { kind: 'failed', error: message };
    }
  }

  /**
   * The merchant-facing refresh, and the one that must NOT block.
   *
   * Two things happen and the order matters. First the store is marked due, in
   * the database, so the request survives this process dying — the nightly
   * sweep is the safety net and it picks up NULLS FIRST. Then the fetch starts
   * in the background and the caller returns immediately.
   *
   * The result is not awaited on purpose: the merchant's next page load reads
   * the row, and a dashboard that hangs while we talk to a third party is the
   * thing this design refuses to build.
   */
  async requestRefresh(storeId: StoreId): Promise<RefreshRequest> {
    if (this.source === null) return { kind: 'unavailable' };

    const current = await this.subscriptions.find(storeId);
    const lastChecked = current?.lastReconciledAt ?? null;
    if (lastChecked !== null) {
      const age = new Date(this.nowInstant()).getTime() - new Date(lastChecked).getTime();
      // Holding the button down must not become a way to make us hammer the
      // platform on a merchant's behalf and earn a rate-limit ban for every
      // other store.
      if (age < REFRESH_THROTTLE_MS) return { kind: 'throttled', lastCheckedAt: lastChecked };
    }

    if (current !== null) await this.subscriptions.markDueForReconciliation(storeId);

    // Detached deliberately. `refreshNow` is TOTAL — `performRefresh` turns
    // every failure, including one thrown synchronously by the source, into a
    // `failed` result — so there is no rejection to handle here and a `.catch`
    // would be dead code standing where a reader expects a safety net. The
    // totality it relies on is asserted by a test rather than assumed.
    void this.refreshNow(storeId);

    return { kind: 'started' };
  }

  /**
   * The install handshake's one fetch.
   *
   * Named separately from `refreshNow` even though it does the same thing,
   * because the reason differs and the log line should say which: at install
   * there is no row yet and a failure means the store starts on a provisional
   * trial, which is recoverable; during a sweep a failure means drift went
   * uncorrected, which is not the same problem.
   */
  async provisionAtInstall(storeId: StoreId): Promise<RefreshResult> {
    const result = await this.refreshNow(storeId);
    if (result.kind === 'failed' || result.kind === 'unavailable') {
      this.logger.warn({
        message: 'could not read the subscription at install; the store starts on a provisional trial',
        storeId,
        outcome: result.kind,
      });
    }
    return result;
  }

  /** Waits for every in-flight refresh. For shutdown, and for tests. */
  async settled(): Promise<void> {
    await Promise.allSettled([...this.inFlight.values()]);
  }
}
