/**
 * @ghalla/core — the profit engine.
 *
 * Pure by construction and by compiler settings: this package builds with
 * `"lib": ["ES2024"], "types": []`, so `fetch`, `process` and `Buffer` do not
 * typecheck here, and it declares exactly one dependency. Adding a second is an
 * architecture decision, not a chore.
 *
 * STATUS: the type surface is complete and the arithmetic is not. Every function
 * body throws `NotImplementedError` pending sign-off on the domain model.
 */

export { CALC_VERSION } from './calc-version.js';

export type { StoreProfitConfig } from './config.js';
export type { ResolvedCost } from './cost.js';
export type {
  CodFeeRule,
  FeeFormula,
  FeeRuleSet,
  GatewayFeeRule,
  ShippingFallbackRule,
} from './fee-rules.js';

export type { Diagnostic, DiagnosticCode } from './diagnostics.js';
export { DIAGNOSTIC_CODES } from './diagnostics.js';

export type { ProfitConfidence, TermBasis } from './confidence.js';

export type {
  OrderProfitComputed,
  OrderProfitLine,
  OrderProfitRejected,
  OrderProfitResult,
  OrderProfitTotals,
  ProfitRecognition,
} from './result.js';

export type { OrderProfitInput } from './input.js';

export type { ComputeOrderProfit } from './compute-order-profit.js';
export { computeOrderProfit } from './compute-order-profit.js';

export {
  addMinor,
  allocateMinor,
  clampMinor,
  mulBps,
  negateMinor,
  splitVatInclusive,
} from './money.js';

export { NotImplementedError } from './not-implemented.js';
