import type { PlatformId } from '@ghalla/contracts';
import { createPlatformRegistry } from '../../src/lib/platforms/registry';
import type { PlatformProbe, PlatformRegistry } from '../../src/lib/platforms/registry';
import type { ReadOnlyDatabase } from '../../src/lib/platforms/read-only';

const CLEAN: PlatformProbe = {
  defaultTransactionReadOnly: true,
  canInsertOrders: false,
  canReadCredentials: false,
  platforms: [],
};

/** A registry over a real PGlite database, so the cross-platform layer is tested end to end. */
export function registryFor(
  databases: Readonly<Record<string, ReadOnlyDatabase>>,
  broken: Readonly<Record<string, string>> = {},
): PlatformRegistry {
  const configs = Object.keys({ ...databases, ...broken }).map((platform) => ({
    platform: platform as PlatformId,
    databaseUrl: `postgres://ro@${platform}/db`,
    adminApi: null,
  }));

  return createPlatformRegistry(configs, (config) => {
    const failure = broken[config.platform];
    return {
      db: databases[config.platform] ?? ({} as ReadOnlyDatabase),
      probe: async () => {
        if (failure !== undefined) throw new Error(failure);
        return CLEAN;
      },
      close: async () => undefined,
    };
  });
}
