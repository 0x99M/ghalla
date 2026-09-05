import { describe, expect, it, vi } from 'vitest';
import type { PlatformId } from '@ghalla/contracts';
import {
  createPlatformRegistry,
  describeCheck,
  evaluateProbe,
  queryPlatforms,
  toProbe,
} from '../src/lib/platforms/registry';
import type { PlatformConnection, PlatformProbe } from '../src/lib/platforms/registry';
import type { ReadOnlyDatabase } from '../src/lib/platforms/read-only';
import type { PlatformConfig } from '../src/lib/platforms/config';

const DEMO = 'demo' as PlatformId;

const GOOD: PlatformProbe = {
  defaultTransactionReadOnly: true,
  canInsertOrders: false,
  canReadCredentials: false,
  platforms: ['demo'],
};

const config = (platform: string): PlatformConfig => ({
  platform: platform as PlatformId,
  databaseUrl: `postgres://ro@${platform}/db`,
  adminApi: null,
});

/** A connection with no Postgres behind it. The `db` is never dereferenced here. */
function fakeConnection(probe: () => Promise<PlatformProbe>): PlatformConnection {
  return {
    db: {} as ReadOnlyDatabase,
    probe,
    close: async () => undefined,
  };
}

describe('evaluateProbe', () => {
  it('passes a role that can only read', () => {
    expect(evaluateProbe(DEMO, GOOD)).toEqual([]);
  });

  it('rejects a role that can write, which is the boundary this portal is built on', () => {
    const problems = evaluateProbe(DEMO, { ...GOOD, canInsertOrders: true });
    expect(problems).toEqual([
      { kind: 'writable', detail: expect.stringContaining('INSERT on orders') },
    ]);
  });

  it('reports a missing read-only default only once the privileges are already right', () => {
    // A role that can write is the bigger finding; saying both would bury it.
    const both = evaluateProbe(DEMO, { ...GOOD, canInsertOrders: true, defaultTransactionReadOnly: false });
    expect(both).toHaveLength(1);
    expect(both[0]).toMatchObject({ detail: expect.stringContaining('INSERT on orders') });

    const onlySetting = evaluateProbe(DEMO, { ...GOOD, defaultTransactionReadOnly: false });
    expect(onlySetting[0]).toMatchObject({ detail: expect.stringContaining('ALTER ROLE') });
  });

  it('rejects a role that can read merchant credentials', () => {
    expect(evaluateProbe(DEMO, { ...GOOD, canReadCredentials: true })).toEqual([
      { kind: 'credentials_readable' },
    ]);
  });

  it('catches a read-only connection pointed at the wrong platform', () => {
    // The mistake no privilege can catch: every number comes back plausible,
    // and every one of them is filed under the wrong name.
    expect(evaluateProbe(DEMO, { ...GOOD, platforms: ['elsewhere'] })).toEqual([
      { kind: 'wrong_platform', found: ['elsewhere'] },
    ]);
  });

  it('accepts a database with no stores yet', () => {
    // A freshly provisioned integration has none, and refusing to read it would
    // make the portal useless exactly while a platform is being brought up.
    expect(evaluateProbe(DEMO, { ...GOOD, platforms: [] })).toEqual([]);
  });

  it('reports every problem at once rather than the worst one', () => {
    const problems = evaluateProbe(DEMO, {
      defaultTransactionReadOnly: false,
      canInsertOrders: true,
      canReadCredentials: true,
      platforms: ['elsewhere'],
    });
    expect(problems.map((p) => p.kind)).toEqual(['writable', 'credentials_readable', 'wrong_platform']);
  });
});

describe('toProbe', () => {
  it('reads the row the probe statement returns', () => {
    expect(
      toProbe({
        read_only: true,
        can_insert_orders: false,
        can_read_credentials: false,
        platforms: ['demo'],
      }),
    ).toEqual(GOOD);
  });

  it('treats a null the driver could not read as the unsafe answer, not the convenient one', () => {
    const probe = toProbe({ read_only: null, can_insert_orders: null, can_read_credentials: null, platforms: null });
    expect(probe.defaultTransactionReadOnly).toBe(false);
    expect(probe.platforms).toEqual([]);
  });
});

describe('createPlatformRegistry', () => {
  it('exposes a handle per configured platform', () => {
    const registry = createPlatformRegistry([config('demo'), config('other')], () =>
      fakeConnection(async () => GOOD),
    );
    expect(registry.platforms).toEqual(['demo', 'other']);
    expect(registry.all()).toHaveLength(2);
    expect(registry.get('demo')?.platform).toBe('demo');
    expect(registry.get('nope')).toBeNull();
  });

  it('caches a successful probe, because configuration does not change under a running container', async () => {
    const probe = vi.fn(async () => GOOD);
    const registry = createPlatformRegistry([config('demo')], () => fakeConnection(probe));

    await registry.verify(DEMO);
    await registry.verify(DEMO);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('does NOT cache a failure, so a blip cannot wedge a platform until the next deploy', async () => {
    let attempt = 0;
    const registry = createPlatformRegistry([config('demo')], () =>
      fakeConnection(async () => {
        attempt += 1;
        if (attempt === 1) throw new Error('connection refused');
        return GOOD;
      }),
    );

    expect(await registry.verify(DEMO)).toMatchObject({ reachable: false, error: 'connection refused' });
    expect(await registry.verify(DEMO)).toMatchObject({ reachable: true, problems: [] });
  });

  it('reports an unregistered platform rather than throwing', async () => {
    const registry = createPlatformRegistry([], () => fakeConnection(async () => GOOD));
    expect(await registry.verify('ghost' as PlatformId)).toMatchObject({
      reachable: false,
      error: '"ghost" is not registered',
    });
  });

  it('describes a thrown non-Error', async () => {
    const registry = createPlatformRegistry([config('demo')], () =>
      fakeConnection(async () => {
        throw 'no route to host';
      }),
    );
    expect((await registry.verify(DEMO)).error).toBe('no route to host');
  });

  it('closes every connection, including when one of them fails to close', async () => {
    const closed: string[] = [];
    const registry = createPlatformRegistry([config('demo'), config('other')], (c) => ({
      db: {} as ReadOnlyDatabase,
      probe: async () => GOOD,
      close: async () => {
        closed.push(c.platform);
        if (c.platform === 'demo') throw new Error('already gone');
      },
    }));

    await expect(registry.close()).resolves.toBeUndefined();
    expect(closed).toEqual(['demo', 'other']);
  });
});

describe('describeCheck', () => {
  it('gives an operator the sentence they need for each kind of problem', () => {
    expect(describeCheck({ platform: DEMO, reachable: false, error: 'timeout', problems: [], checkedAt: '' })).toBe(
      'timeout',
    );
    expect(
      describeCheck({
        platform: DEMO,
        reachable: true,
        error: null,
        problems: [{ kind: 'credentials_readable' }, { kind: 'wrong_platform', found: ['elsewhere'] }],
        checkedAt: '',
      }),
    ).toBe('the connected role can read platform_credentials; revoke it; this database holds stores for elsewhere');
  });

  it('falls back to a word when a failure carried no message', () => {
    expect(describeCheck({ platform: DEMO, reachable: false, error: null, problems: [], checkedAt: '' })).toBe(
      'unreachable',
    );
  });
});

describe('queryPlatforms', () => {
  it('queries only the platforms that passed verification', async () => {
    const registry = createPlatformRegistry([config('demo'), config('other')], (c) =>
      fakeConnection(async () => (c.platform === 'demo' ? GOOD : { ...GOOD, canInsertOrders: true })),
    );

    const result = await queryPlatforms(registry, async (handle) => handle.platform);
    expect(result.ok).toEqual([{ platform: 'demo', value: 'demo' }]);
    expect(result.failed[0]).toMatchObject({ platform: 'other' });
    expect(result.partial).toBe(true);
  });

  it('never runs a query against a writable connection', async () => {
    const run = vi.fn(async () => 'queried');
    const registry = createPlatformRegistry([config('demo')], () =>
      fakeConnection(async () => ({ ...GOOD, canInsertOrders: true })),
    );

    await queryPlatforms(registry, run);
    expect(run).not.toHaveBeenCalled();
  });

  it('merges a blocked platform and a failed query into one list', async () => {
    const registry = createPlatformRegistry([config('demo'), config('other')], (c) =>
      fakeConnection(async () => (c.platform === 'demo' ? GOOD : { ...GOOD, canReadCredentials: true })),
    );

    const result = await queryPlatforms(registry, async () => {
      throw new Error('statement timeout');
    });
    expect(result.failed.map((f) => f.platform).sort()).toEqual(['demo', 'other']);
    expect(result.ok).toEqual([]);
  });

  it('is not partial when every platform is usable', async () => {
    const registry = createPlatformRegistry([config('demo')], () => fakeConnection(async () => GOOD));
    const result = await queryPlatforms(registry, async () => 1);
    expect(result.partial).toBe(false);
  });
});
