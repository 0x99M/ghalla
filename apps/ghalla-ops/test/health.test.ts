import { describe, expect, it } from 'vitest';
import type { PlatformId } from '@ghalla/contracts';
import { checkHealth, toPlatformHealth } from '../src/lib/health';
import type { ConnectionCheck, PlatformRegistry } from '../src/lib/platforms/registry';

const AT = '2026-09-05T09:00:00.000Z';

function registryReturning(checks: readonly ConnectionCheck[]): PlatformRegistry {
  return {
    platforms: checks.map((c) => c.platform),
    get: () => null,
    all: () => [],
    verify: async () => checks[0] as ConnectionCheck,
    verifyAll: async () => checks,
    close: async () => undefined,
  };
}

const ok = (platform: string): ConnectionCheck => ({
  platform: platform as PlatformId,
  reachable: true,
  error: null,
  problems: [],
  checkedAt: AT,
});

describe('checkHealth', () => {
  it('is ok when the portal and every platform are', async () => {
    const report = await checkHealth({
      registry: registryReturning([ok('demo')]),
      pingPortal: async () => undefined,
      now: () => AT,
    });
    expect(report).toMatchObject({ status: 'ok', portalDatabase: 'ok', partial: false, checkedAt: AT });
  });

  it('is DEGRADED, not error, when a platform is unreachable', async () => {
    // The brief's requirement, stated as a test: the portal has to serve with a
    // platform database down. A health check that failed here would let
    // somebody else's outage restart this container.
    const report = await checkHealth({
      registry: registryReturning([
        ok('demo'),
        { platform: 'other' as PlatformId, reachable: false, error: 'timeout', problems: [], checkedAt: AT },
      ]),
      pingPortal: async () => undefined,
    });

    expect(report.status).toBe('degraded');
    expect(report.portalDatabase).toBe('ok');
    expect(report.partial).toBe(true);
    expect(report.platforms[1]).toEqual({
      platform: 'other',
      reachable: false,
      usable: false,
      detail: 'timeout',
    });
  });

  it('is degraded when a platform is reachable but must not be read', async () => {
    const report = await checkHealth({
      registry: registryReturning([
        {
          platform: 'demo' as PlatformId,
          reachable: true,
          error: null,
          problems: [{ kind: 'writable', detail: 'holds INSERT' }],
          checkedAt: AT,
        },
      ]),
      pingPortal: async () => undefined,
    });
    expect(report.status).toBe('degraded');
    expect(report.platforms[0]).toMatchObject({ reachable: true, usable: false, detail: 'holds INSERT' });
  });

  it('is an error when the portal cannot reach its OWN database', async () => {
    const report = await checkHealth({
      registry: registryReturning([ok('demo')]),
      pingPortal: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    expect(report).toMatchObject({ status: 'error', portalDatabase: 'error', portalDatabaseError: 'ECONNREFUSED' });
  });

  it('describes a thrown non-Error from the portal ping', async () => {
    const report = await checkHealth({
      registry: registryReturning([ok('demo')]),
      pingPortal: async () => {
        throw 'socket hang up';
      },
    });
    expect(report.portalDatabaseError).toBe('socket hang up');
  });

  it('still answers when verification itself breaks', async () => {
    // A health endpoint that 500s tells the operator nothing at all.
    const registry = registryReturning([]);
    const report = await checkHealth({
      registry: { ...registry, verifyAll: async () => Promise.reject(new Error('registry gone')) },
      pingPortal: async () => undefined,
    });
    expect(report).toMatchObject({ status: 'error', portalDatabaseError: 'registry gone' });
    expect(report.platforms).toEqual([]);
  });

  it("keeps the portal's own failure when verification breaks too", async () => {
    const registry = registryReturning([]);
    const report = await checkHealth({
      registry: { ...registry, verifyAll: async () => Promise.reject('secondary') },
      pingPortal: async () => {
        throw new Error('primary');
      },
    });
    expect(report.portalDatabaseError).toBe('primary');
  });

  it('describes a thrown non-Error from verification', async () => {
    const registry = registryReturning([]);
    const report = await checkHealth({
      registry: { ...registry, verifyAll: async () => Promise.reject('registry vanished') },
      pingPortal: async () => undefined,
    });
    expect(report.portalDatabaseError).toBe('registry vanished');
  });

  it('stamps a real timestamp by default', async () => {
    const report = await checkHealth({
      registry: registryReturning([]),
      pingPortal: async () => undefined,
    });
    expect(Number.isNaN(Date.parse(report.checkedAt))).toBe(false);
  });
});

describe('toPlatformHealth', () => {
  it('carries no detail when there is nothing wrong', () => {
    expect(toPlatformHealth(ok('demo'))).toEqual({
      platform: 'demo',
      reachable: true,
      usable: true,
      detail: null,
    });
  });
});
