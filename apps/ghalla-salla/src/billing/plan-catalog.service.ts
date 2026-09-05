import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { comparePlanCatalog, describeMismatch } from '@ghalla/billing';
import type { CatalogMismatch, PlanListing } from '@ghalla/billing';
import type { PlatformPlan } from '@ghalla/ports';
import { PLAN_CATALOG_SOURCE } from './plan-catalog.source.js';
import type { PlanCatalogSource } from './plan-catalog.source.js';

/**
 * Keeping the plan table in this codebase honest about the one at the platform.
 *
 * Prices live in `PLANS` — see the argument at the top of `plans.ts` — and that
 * is only defensible because of this. The two tables are separate systems
 * edited by different people at different times, and when they drift both sides
 * stay internally consistent: the platform charges its number, the code grants
 * the tier it thinks its own number buys, and the merchant is the only party
 * who sees both.
 *
 * WHAT A MISMATCH DOES, and what it deliberately does not do:
 *
 *   - it fails the HEALTHCHECK, so a deploy that introduces one does not go
 *     green and Railway keeps the previous version;
 *   - it does NOT stop a running service. Ingestion and profit computation
 *     carry on, because a data gap is permanent and a wrong price on a pricing
 *     page is not — the same asymmetry the soft caps are built on. Somebody
 *     editing a price at 23:00 must not take down every merchant's ingestion.
 *
 * The check is never on a request path. It runs once at startup and hourly
 * after that, and the healthcheck reads the stored answer.
 */

export type CatalogStatus =
  /** Checked, and the two tables agree. */
  | { readonly state: 'ok'; readonly plansChecked: number; readonly checkedAt: string }
  /** Checked, and they do not. The deploy gate. */
  | { readonly state: 'mismatch'; readonly problems: readonly string[]; readonly checkedAt: string }
  /** No source is wired, or the platform could not be reached. NOT a green light. */
  | { readonly state: 'unverified'; readonly reason: string; readonly checkedAt: string | null }
  /** The startup check has not answered yet. Health treats this as not-yet-ready. */
  | { readonly state: 'pending' };

/**
 * How long the startup check may take before it is called unreachable.
 *
 * Bounded because it runs before the service reports ready: a platform that
 * accepts the connection and never answers must not hold a deploy open until
 * the healthcheck window expires.
 */
export const CATALOG_TIMEOUT_MS = 10_000;

@Injectable()
export class PlanCatalogService {
  private readonly logger = new Logger(PlanCatalogService.name);
  private status: CatalogStatus = { state: 'pending' };
  private inFlight: Promise<CatalogStatus> | null = null;

  constructor(@Optional() @Inject(PLAN_CATALOG_SOURCE) private readonly source: PlanCatalogSource | null = null) {}

  protected nowIso(): string {
    return new Date().toISOString();
  }

  current(): CatalogStatus {
    return this.status;
  }

  /**
   * Started at boot, NOT awaited by it.
   *
   * Blocking startup on a third party's API is the thing this codebase refuses
   * to do everywhere else, and there is no reason to make an exception for a
   * consistency check. The healthcheck reports `pending` until this answers,
   * which is a few hundred milliseconds in the normal case and at most
   * `CATALOG_TIMEOUT_MS` in the worst — comfortably inside the deploy's
   * healthcheck window, so the gate still has teeth.
   */
  onModuleInit(): void {
    void this.check();
  }

  /** 04:00 UTC. An hour after the reconciler, so two external sweeps do not collide. */
  @Cron(CronExpression.EVERY_HOUR)
  async recheck(): Promise<void> {
    await this.check();
  }

  async check(): Promise<CatalogStatus> {
    const existing = this.inFlight;
    if (existing !== null) return existing;

    const run = this.performCheck().finally(() => {
      this.inFlight = null;
    });
    this.inFlight = run;
    return run;
  }

  private async performCheck(): Promise<CatalogStatus> {
    if (this.source === null) {
      return this.settle({
        state: 'unverified',
        reason: 'no plan catalog source is wired; the local plan table is unchecked',
        checkedAt: null,
      });
    }

    let plans: readonly PlatformPlan[];
    try {
      plans = await this.withTimeout(this.source.fetchPlans());
    } catch (error) {
      // Unreachable is NOT a mismatch. A third party being down must not fail
      // our deploys — the check simply has no answer, and says so.
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.warn({ message: 'could not read the platform plan catalog', reason });
      return this.settle({ state: 'unverified', reason, checkedAt: this.nowIso() });
    }

    const verdict = comparePlanCatalog(plans.map(PlanCatalogService.toListing));
    if (verdict.kind === 'ok') {
      return this.settle({ state: 'ok', plansChecked: verdict.plansChecked, checkedAt: this.nowIso() });
    }

    const problems = verdict.mismatches.map(describeMismatch);
    // At `error`, with every disagreement named. This is the log line somebody
    // reads at the moment a deploy refuses to go green, so it has to say what
    // to change rather than that something is wrong.
    this.logger.error({
      message: 'the local plan table disagrees with the platform',
      mismatches: verdict.mismatches.map((m: CatalogMismatch) => m.kind),
      problems,
    });
    return this.settle({ state: 'mismatch', problems, checkedAt: this.nowIso() });
  }

  private settle(status: CatalogStatus): CatalogStatus {
    this.status = status;
    return status;
  }

  private async withTimeout(work: Promise<readonly PlatformPlan[]>): Promise<readonly PlatformPlan[]> {
    const timeout = new Promise<never>((_resolve, reject) => {
      // `unref` rather than a `clearTimeout` in a `finally`. The loser of this
      // race is simply abandoned, so there is nothing to clean up — and an
      // unref'd timer cannot hold the process open while it waits to lose.
      // Clearing it would have meant asking whether it had been set, which is
      // a branch no execution can take.
      setTimeout(() => {
        reject(new Error(`the platform did not answer within ${String(CATALOG_TIMEOUT_MS)}ms`));
      }, CATALOG_TIMEOUT_MS).unref();
    });
    return Promise.race([work, timeout]);
  }

  private static toListing(plan: PlatformPlan): PlanListing {
    return {
      platformPlanId: plan.platformPlanId,
      planCode: plan.planCode,
      priceMinor: plan.priceMinor,
      interval: plan.interval,
    };
  }
}
