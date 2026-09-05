import type { PlatformId } from '@ghalla/contracts';
import type { ReadOnlyDatabase } from './read-only';
import { describeError } from '../errors';
import { fanOut } from './fanout';
import type { FanOut, PlatformFailure } from './fanout';
import type { AdminApiConfig, PlatformConfig } from './config';

/**
 * Platform slug to read-only handle. The portal's whole data-access surface.
 *
 * There is one Postgres per integration and no way to join across them, so
 * "read every platform" is a fan-out and a merge and never a query. This is the
 * thing being fanned out over.
 */

export interface PlatformHandle {
  readonly platform: PlatformId;
  /** SELECT only. See `read-only.ts` for why that is a type and not a convention. */
  readonly db: ReadOnlyDatabase;
  /** `null` where the integration exposes no admin API yet. Actions report unavailable. */
  readonly adminApi: AdminApiConfig | null;
}

/**
 * What is wrong with a connection, as a LIST rather than a winner.
 *
 * A database can be both writable and the wrong one, and a union that picks the
 * most severe would hide the second problem until the first was fixed — two
 * deploys to learn what one probe already knew.
 */
export type ConnectionProblem =
  /** The role can write. The safety boundary is not in place. */
  | { readonly kind: 'writable'; readonly detail: string }
  /** The role can read `platform_credentials`. The portal must never be able to. */
  | { readonly kind: 'credentials_readable' }
  /** The stores in this database belong to a different platform than the variable claims. */
  | { readonly kind: 'wrong_platform'; readonly found: readonly string[] };

export interface ConnectionCheck {
  readonly platform: PlatformId;
  readonly reachable: boolean;
  readonly error: string | null;
  readonly problems: readonly ConnectionProblem[];
  readonly checkedAt: string;
}

/** What the probe statement returns. Kept separate so the judging is a pure function. */
export interface PlatformProbe {
  readonly defaultTransactionReadOnly: boolean;
  readonly canInsertOrders: boolean;
  readonly canReadCredentials: boolean;
  /** Distinct `stores.platform` values actually present. Empty on a store-less database. */
  readonly platforms: readonly string[];
}

/**
 * One statement, asking the three questions that decide whether this connection
 * is allowed to be used at all.
 *
 * `has_table_privilege` is the decisive one. `default_transaction_read_only`
 * only sets a session default and a client can still ask for a writable
 * transaction, so it is reported but it is not the guarantee — the guarantee is
 * that the role does not hold INSERT. Asking Postgres directly beats reading
 * the connection string and hoping the username means what it says.
 *
 * The last question catches the mistake no privilege can: a correctly read-only
 * connection pointed at the WRONG platform's database, where every number comes
 * back plausible and mislabelled.
 */
export const PROBE_SQL = `
  select
    current_setting('default_transaction_read_only') = 'on'          as read_only,
    has_table_privilege(current_user, 'orders', 'INSERT')            as can_insert_orders,
    has_table_privilege(current_user, 'platform_credentials', 'SELECT') as can_read_credentials,
    coalesce((select array_agg(distinct platform) from stores), '{}') as platforms
`;

/**
 * Judges a probe. Pure, so every combination is a table test rather than a
 * database someone has to misconfigure on purpose.
 *
 * A store-less database yields no platform values and is NOT called wrong: a
 * freshly provisioned integration has no stores yet, and refusing to read it
 * would make the portal useless exactly when a new platform is being brought up.
 */
export function evaluateProbe(platform: PlatformId, probe: PlatformProbe): readonly ConnectionProblem[] {
  const problems: ConnectionProblem[] = [];

  if (probe.canInsertOrders) {
    problems.push({
      kind: 'writable',
      detail: 'the connected role holds INSERT on orders; the portal must connect as a read-only role',
    });
  } else if (!probe.defaultTransactionReadOnly) {
    // Only worth saying when the privileges are already right: a role that can
    // write is the bigger finding and this would be noise beside it.
    problems.push({
      kind: 'writable',
      detail: 'the connected role has default_transaction_read_only off; set it with ALTER ROLE',
    });
  }

  if (probe.canReadCredentials) problems.push({ kind: 'credentials_readable' });

  const foreign = probe.platforms.filter((found) => found !== platform);
  if (foreign.length > 0) problems.push({ kind: 'wrong_platform', found: foreign });

  return problems;
}

/** The probe statement's row, as the driver hands it back. */
interface ProbeRow {
  readonly read_only: boolean | null;
  readonly can_insert_orders: boolean | null;
  readonly can_read_credentials: boolean | null;
  readonly platforms: readonly string[] | null;
}

/**
 * Row to probe, defensively.
 *
 * Every field is compared to `true` rather than coerced: a driver that hands
 * back `null` for a column it could not read must not be rounded off into
 * "false, so no problem" on the two questions where false is the safe answer.
 * A missing `platforms` array is an empty one, which reads as a store-less
 * database rather than as a mismatch.
 */
export function toProbe(row: unknown): PlatformProbe {
  const parsed = row as ProbeRow;
  return {
    defaultTransactionReadOnly: parsed.read_only === true,
    canInsertOrders: parsed.can_insert_orders === true,
    canReadCredentials: parsed.can_read_credentials === true,
    platforms: parsed.platforms ?? [],
  };
}

/** One integration's connection. An interface so tests need no Postgres to drive the registry. */
export interface PlatformConnection {
  readonly db: ReadOnlyDatabase;
  probe(): Promise<PlatformProbe>;
  close(): Promise<void>;
}

export type ConnectionFactory = (config: PlatformConfig) => PlatformConnection;

export interface RegistryOptions {
  readonly now?: (() => string) | undefined;
}


export interface PlatformRegistry {
  readonly platforms: readonly PlatformId[];
  get(platform: string): PlatformHandle | null;
  all(): readonly PlatformHandle[];
  verify(platform: PlatformId): Promise<ConnectionCheck>;
  verifyAll(): Promise<readonly ConnectionCheck[]>;
  close(): Promise<void>;
}

/**
 * `connect` is a required argument rather than a defaulted one, deliberately.
 *
 * A default would make the real Postgres factory reachable from anywhere,
 * including a test that meant to pass a fake and forgot — and the symptom of
 * that is a suite trying to open sockets, which is slow, flaky and confusing in
 * roughly that order. Requiring it means the composition root is the only place
 * that names a driver.
 */
export function createPlatformRegistry(
  configs: readonly PlatformConfig[],
  connect: ConnectionFactory,
  options: RegistryOptions = {},
): PlatformRegistry {
  const now = options.now ?? ((): string => new Date().toISOString());

  const connections = new Map<PlatformId, PlatformConnection>();
  const handles = new Map<PlatformId, PlatformHandle>();
  /**
   * Successful probes are cached for the life of the process; failures are not.
   *
   * A probe answers a question about configuration, and configuration does not
   * change under a running container — so re-asking is pure cost. A FAILED
   * probe is a different thing: a network blip during the first request would
   * otherwise wedge that platform as broken until someone redeployed.
   */
  const verified = new Map<PlatformId, ConnectionCheck>();

  for (const config of configs) {
    const connection = connect(config);
    connections.set(config.platform, connection);
    handles.set(config.platform, {
      platform: config.platform,
      db: connection.db,
      adminApi: config.adminApi,
    });
  }

  async function verify(platform: PlatformId): Promise<ConnectionCheck> {
    const cached = verified.get(platform);
    if (cached !== undefined) return cached;

    const connection = connections.get(platform);
    if (connection === undefined) {
      return {
        platform,
        reachable: false,
        error: `"${platform}" is not registered`,
        problems: [],
        checkedAt: now(),
      };
    }

    try {
      const probe = await connection.probe();
      const check: ConnectionCheck = {
        platform,
        reachable: true,
        error: null,
        problems: evaluateProbe(platform, probe),
        checkedAt: now(),
      };
      verified.set(platform, check);
      return check;
    } catch (error) {
      return {
        platform,
        reachable: false,
        error: describeError(error),
        problems: [],
        checkedAt: now(),
      };
    }
  }

  return {
    platforms: configs.map((config) => config.platform),
    get(platform: string): PlatformHandle | null {
      return handles.get(platform as PlatformId) ?? null;
    },
    all(): readonly PlatformHandle[] {
      return [...handles.values()];
    },
    verify,
    async verifyAll(): Promise<readonly ConnectionCheck[]> {
      return Promise.all(configs.map(async (config) => verify(config.platform)));
    },
    async close(): Promise<void> {
      await Promise.allSettled([...connections.values()].map(async (c) => c.close()));
    },
  };
}

function describeProblem(problem: ConnectionProblem): string {
  if (problem.kind === 'writable') return problem.detail;
  if (problem.kind === 'credentials_readable') {
    return 'the connected role can read platform_credentials; revoke it';
  }
  return `this database holds stores for ${problem.found.join(', ')}`;
}

/** Why a platform was left out of a result, in words an operator can act on. */
export function describeCheck(check: ConnectionCheck): string {
  if (!check.reachable) return check.error ?? 'unreachable';
  return check.problems.map(describeProblem).join('; ');
}

/**
 * THE entry point for every cross-platform read.
 *
 * Verification happens first and a platform that fails it is not queried at
 * all. Any problem blocks — not just the reachability ones — because each of
 * them means a number this portal produced would be untrustworthy in a way the
 * reader could not see: a writable connection means the safety boundary is not
 * in place, a readable credentials table means the portal can see things it
 * must not, and a mismatched platform means every figure is correct and filed
 * under the wrong name.
 *
 * Blocked platforms come back in `failed` beside the ones that were merely
 * down, so the page still renders and still says what is missing.
 */
export async function queryPlatforms<T>(
  registry: PlatformRegistry,
  run: (handle: PlatformHandle) => Promise<T>,
  options: { readonly now?: (() => string) | undefined } = {},
): Promise<FanOut<T>> {
  const checks = await registry.verifyAll();
  const usable: PlatformHandle[] = [];
  const blocked: PlatformFailure[] = [];

  for (const check of checks) {
    const handle = registry.get(check.platform);
    if (handle !== null && check.reachable && check.problems.length === 0) {
      usable.push(handle);
    } else {
      blocked.push({ platform: check.platform, reason: describeCheck(check) });
    }
  }

  const result = await fanOut(usable, run, options);
  return {
    ok: result.ok,
    failed: [...blocked, ...result.failed],
    partial: blocked.length > 0 || result.partial,
    capturedAt: result.capturedAt,
  };
}
