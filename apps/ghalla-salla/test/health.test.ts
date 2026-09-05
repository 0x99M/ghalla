import { afterEach, describe, expect, it, vi } from 'vitest';

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

type Db = ConstructorParameters<typeof HealthService>[0];

const dbThat = (execute: () => Promise<unknown>): Db => ({ execute }) as unknown as Db;

const reachable = (): Db => dbThat(() => Promise.resolve([{ '?column?': 1 }]));
const unreachable = (): Db => dbThat(() => Promise.reject(new Error('ECONNREFUSED')));

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('HealthService', () => {
  it('reports ok only after actually reaching the database', async () => {
    // A check that proves only "the process is listening" is worse than none on
    // a platform that routes on it: the deploy goes green and the first real
    // request discovers the database URL is wrong.
    const report = await new HealthService(reachable()).check({});
    expect(report).toStrictEqual({
      status: 'ok',
      database: 'ok',
      environment: undefined,
      commit: undefined,
    });
  });

  it('reports degraded when the database is unreachable, rather than throwing', async () => {
    // Throwing here would surface as a 500 with a stack trace; the platform and
    // the on-call engineer both want a structured answer.
    const report = await new HealthService(unreachable()).check({});
    expect(report.status).toBe('degraded');
    expect(report.database).toBe('unreachable');
  });

  it('echoes the environment and commit, so two lookalike deploys are tellable apart', async () => {
    const report = await new HealthService(reachable()).check({
      railwayEnvironment: 'staging',
      gitSha: 'deadbee',
    });
    expect(report.environment).toBe('staging');
    expect(report.commit).toBe('deadbee');
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
    const controller = new HealthController(new HealthService(reachable()));
    const body = await controller.healthcheck(res);
    expect(body.status).toBe('ok');
    expect(status).not.toHaveBeenCalled();
  });

  it('names the environment and commit it is answering for', async () => {
    // Two Railway environments run the same image. When one is wrong, the reply
    // has to say which one answered.
    withEnv();
    const { res } = responseSpy();
    const controller = new HealthController(new HealthService(reachable()));
    const body = await controller.healthcheck(res);
    expect(body.environment).toBe('staging');
    expect(body.commit).toBe('c0ffee1');
  });

  it('returns 503 when the database is unreachable', async () => {
    // The platform reads the STATUS CODE. A 200 carrying {"status":"degraded"}
    // tells it to route production traffic at a service that cannot answer.
    withEnv();
    const { res, status } = responseSpy();
    const controller = new HealthController(new HealthService(unreachable()));
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
      new HealthService(dbThat(() => Promise.reject(new Error('nope')))),
    );
    expect(controller.ping()).toStrictEqual({ pong: true });
  });
});
