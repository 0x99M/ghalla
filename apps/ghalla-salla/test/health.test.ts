import { afterEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';

// The health module reaches the Postgres driver through `db.module.js`, and
// asks drizzle for a `SELECT 1`. Neither belongs in a unit test of the check
// itself: what is under test is what the service concludes from a round trip
// that succeeds or fails, not the round trip.
vi.mock('pg', () => ({ Pool: class {} }));
vi.mock('drizzle-orm', () => ({
  sql: (strings: TemplateStringsArray): { readonly query: string } => ({ query: strings.join('') }),
}));

const { HealthService } = await import('../src/health/health.service.js');
const { HealthController } = await import('../src/health/health.controller.js');
const { readJournalTags } = await import('@ghalla/persistence');

type Db = ConstructorParameters<typeof HealthService>[0];

const dbThat = (execute: () => Promise<unknown>): Db => ({ execute }) as unknown as Db;

/**
 * The service now asks two questions per check: is the database there, and is
 * it the shape this build expects. `SELECT 1` and the migration count go
 * through the same `execute`, so a reachable database answers both — the count
 * it returns is what decides `schema`.
 */
const reachable = (applied = 2): Db =>
  dbThat(() => Promise.resolve({ rows: [{ n: applied }] }));
const unreachable = (): Db => dbThat(() => Promise.reject(new Error('ECONNREFUSED')));

// The real journal, so `expected` is whatever this build actually ships.
const MIGRATIONS = path.resolve(import.meta.dirname, '..', '..', '..', 'packages', 'persistence', 'drizzle');
const EXPECTED = readJournalTags(MIGRATIONS).length;

const AT = '2026-09-05T12:00:00.000Z';

const service = (db: Db): InstanceType<typeof HealthService> =>
  new HealthService(db, MIGRATIONS, {
    // A catalog check that has already answered `ok`, so these tests exercise
    // the database and schema halves rather than the plan half. The plan half
    // has its own suite.
    current: () => ({ state: 'ok', plansChecked: 6, checkedAt: '2026-09-05T12:00:00.000Z' }),
  } as never);

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('HealthService', () => {
  it('reports ok only after actually reaching the database', async () => {
    // A check that proves only "the process is listening" is worse than none on
    // a platform that routes on it: the deploy goes green and the first real
    // request discovers the database URL is wrong.
    const report = await service(reachable(EXPECTED)).check({});
    expect(report).toStrictEqual({
      status: 'ok',
      database: 'ok',
      schema: 'current',
      migrations: { applied: EXPECTED, expected: EXPECTED },
      plans: { state: 'ok', plansChecked: 6, checkedAt: AT },
      environment: undefined,
      commit: undefined,
    });
  });

  it('DEGRADES ON A PLAN MISMATCH, so the deploy that introduced one cannot go green', async () => {
    // The database is fine and the schema is current; the only thing wrong is
    // that this build's prices disagree with the platform's. That is exactly
    // the fault worth stopping a release for: both systems keep working, and
    // the merchant is charged for a tier the code will not grant them.
    const withMismatch = new HealthService(reachable(EXPECTED), MIGRATIONS, {
      current: () => ({ state: 'mismatch', problems: ['"growth" is 24900 here and 19900 at the platform'], checkedAt: AT }),
    } as never);

    const report = await withMismatch.check({});
    expect(report.database).toBe('ok');
    expect(report.schema).toBe('current');
    expect(report.status).toBe('degraded');
  });

  it('stays green when the catalog is merely UNVERIFIED', async () => {
    // No source wired, or the platform is down. Neither is evidence of a fault
    // on our side, and failing on it would let a third party's outage block
    // every deploy we make.
    const unverified = new HealthService(reachable(EXPECTED), MIGRATIONS, {
      current: () => ({ state: 'unverified', reason: 'no plan catalog source is wired', checkedAt: null }),
    } as never);
    expect((await unverified.check({})).status).toBe('ok');
  });

  it('reports degraded when the database is unreachable, rather than throwing', async () => {
    // Throwing here would surface as a 500 with a stack trace; the platform and
    // the on-call engineer both want a structured answer.
    const report = await service(unreachable()).check({});
    expect(report.status).toBe('degraded');
    expect(report.database).toBe('unreachable');
  });

  it('echoes the environment and commit, so two lookalike deploys are tellable apart', async () => {
    const report = await service(reachable(EXPECTED)).check({
      railwayEnvironment: 'staging',
      gitSha: 'deadbee',
    });
    expect(report.environment).toBe('staging');
    expect(report.commit).toBe('deadbee');
  });
});

describe('HealthService and the schema it is talking to', () => {
  it('degrades when the database is behind the migrations this build ships', async () => {
    // The pre-deploy hook makes this impossible, which is why it is worth
    // asserting: reaching it means the hook did not run. The process would
    // otherwise start, answer, and return numbers computed against a schema
    // missing the columns the code was just taught to read.
    const report = await service(reachable(EXPECTED - 1)).check({});
    expect(report.status).toBe('degraded');
    expect(report.schema).toBe('behind');
    expect(report.migrations).toStrictEqual({ applied: EXPECTED - 1, expected: EXPECTED });
  });

  it('degrades when the database is ahead, which is a rollback', async () => {
    // Distinct from `behind` because the remedy is the opposite: rolling
    // forward is safe, "fixing" it by migrating is not.
    const report = await service(reachable(EXPECTED + 1)).check({});
    expect(report.status).toBe('degraded');
    expect(report.schema).toBe('ahead');
  });

  it('does not ask about the schema when the database is unreachable', async () => {
    // A second failing round trip would only repeat what the first said.
    const report = await service(unreachable()).check({});
    expect(report.database).toBe('unreachable');
    expect(report.schema).toBe('unknown');
    expect(report.migrations).toStrictEqual({ applied: 0, expected: 0 });
  });

  it('reports the counts so an operator can see how far behind it is', async () => {
    const report = await service(reachable(EXPECTED)).check({});
    expect(report.migrations.expected).toBe(EXPECTED);
    expect(report.migrations.applied).toBe(EXPECTED);
  });
});

describe('HealthController', () => {
  interface ResponseSpy {
    readonly res: Parameters<InstanceType<typeof HealthController>['healthcheck']>[0];
    readonly status: ReturnType<typeof vi.fn>;
  }

  const responseSpy = (): ResponseSpy => {
    const status = vi.fn();
    return { res: { status } as unknown as ResponseSpy['res'], status };
  };

  const withEnv = (): void => {
    // The controller re-reads the environment on every check, so without this
    // the healthcheck would die on a missing DATABASE_URL rather than answer.
    vi.stubEnv('DATABASE_URL', 'postgres://user:pass@db:5432/ghalla');
    vi.stubEnv('RAILWAY_ENVIRONMENT_NAME', 'staging');
    vi.stubEnv('RAILWAY_GIT_COMMIT_SHA', 'c0ffee1');
  };

  it('leaves the status code alone when everything is healthy', async () => {
    withEnv();
    const { res, status } = responseSpy();
    const controller = new HealthController(service(reachable(EXPECTED)));
    const body = await controller.healthcheck(res);
    expect(body.status).toBe('ok');
    expect(status).not.toHaveBeenCalled();
  });

  it('names the environment and commit it is answering for', async () => {
    // Two Railway environments run the same image. When one is wrong, the reply
    // has to say which one answered.
    withEnv();
    const { res } = responseSpy();
    const controller = new HealthController(service(reachable(EXPECTED)));
    const body = await controller.healthcheck(res);
    expect(body.environment).toBe('staging');
    expect(body.commit).toBe('c0ffee1');
  });

  it('returns 503 when the database is unreachable', async () => {
    // The platform reads the STATUS CODE. A 200 carrying {"status":"degraded"}
    // tells it to route production traffic at a service that cannot answer.
    withEnv();
    const { res, status } = responseSpy();
    const controller = new HealthController(service(unreachable()));
    const body = await controller.healthcheck(res);
    expect(body.status).toBe('degraded');
    expect(status).toHaveBeenCalledWith(503);
  });

  it('answers ping without touching anything', () => {
    // Liveness only. It must keep working when the database is down, which is
    // what makes it useful for telling "process dead" from "database dead".
    // The environment is stubbed because the controller reads it ONCE at
    // construction — it no longer re-reads per request, which is what used to
    // let a healthcheck throw instead of answering.
    withEnv();
    const controller = new HealthController(
      service(dbThat(() => Promise.reject(new Error('nope')))),
    );
    expect(controller.ping()).toStrictEqual({ pong: true });
  });
});
