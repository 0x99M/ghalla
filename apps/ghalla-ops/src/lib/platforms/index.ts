import { loadPlatformConfigs } from './config';
import { createPlatformRegistry } from './registry';
import { createPostgresConnection } from './postgres-connection';
import type { PlatformRegistry } from './registry';

/**
 * The composition root. The only place that names a driver.
 *
 * Held on `globalThis` rather than in a module-level `let`, because Next
 * re-evaluates modules on every hot reload in development: a plain singleton
 * would open a fresh pool per edit and leak connections into the integration
 * databases all afternoon, which is a rude thing to do to a service that is
 * serving merchants.
 */

const REGISTRY_KEY = Symbol.for('ghalla.ops.registry');

interface RegistryHolder {
  [REGISTRY_KEY]?: PlatformRegistry;
}

export function getRegistry(): PlatformRegistry {
  const holder = globalThis as RegistryHolder;
  const existing = holder[REGISTRY_KEY];
  if (existing !== undefined) return existing;

  const registry = createPlatformRegistry(loadPlatformConfigs(process.env), createPostgresConnection);
  holder[REGISTRY_KEY] = registry;
  return registry;
}
