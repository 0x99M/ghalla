import type {
  CanonicalOrder,
  CanonicalOrderItem,
  CanonicalReversal,
  CanonicalShipment,
} from '@ghalla/contracts';
import type { StoreProfitConfig } from './config.js';
import type { ResolvedCost } from './cost.js';
import type { FeeRuleSet } from './fee-rules.js';

/**
 * Every input the engine sees, passed explicitly. No database handle, no clock,
 * no configuration read from the environment.
 *
 * `costs` is an ARRAY, not a `Map`. `JSON.stringify(new Map([['a', 1]]))` is
 * `'{}'` — a golden fixture written with a Map would silently lose its entire
 * cost table and then pass, with every cost recorded as missing. A green test
 * asserting nothing is worse than no test.
 */
export interface OrderProfitInput {
  readonly store: StoreProfitConfig;
  readonly order: CanonicalOrder;
  readonly items: readonly CanonicalOrderItem[];
  readonly shipments: readonly CanonicalShipment[];
  readonly reversals: readonly CanonicalReversal[];
  readonly costs: readonly ResolvedCost[];
  readonly feeRuleSet: FeeRuleSet;
}
