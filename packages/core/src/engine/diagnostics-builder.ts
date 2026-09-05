import type { Diagnostic, DiagnosticCode } from '../diagnostics.js';

/**
 * Provenance is recorded where the fact is known, not reconstructed afterwards.
 * Every sub-function returns its value alongside the diagnostics it produced,
 * and `confidence` is then a pure projection of the union — so the two channels
 * cannot drift.
 */
export interface Computed<T> {
  readonly value: T;
  readonly diagnostics: readonly Diagnostic[];
}

const FATAL: readonly DiagnosticCode[] = [
  'CURRENCY_MISMATCH',
  'ITEM_ORDER_ID_MISMATCH',
  'REVERSAL_ORDER_ID_MISMATCH',
  'NON_INTEGER_MINOR_UNITS',
  'NEGATIVE_QUANTITY',
  'NON_INTEGER_QUANTITY',
  'DUPLICATE_COST_KEY',
  'DUPLICATE_ITEM_ID',
  'DUPLICATE_RULE_KEY',
  'FEE_RULE_INVALID',
  'MALFORMED_INPUT',
  'MALFORMED_TIMESTAMP',
  'INVALID_TIMEZONE',
  'INTERNAL_INVARIANT_VIOLATED',
];

export function severityOf(code: DiagnosticCode): 'warning' | 'fatal' {
  return FATAL.includes(code) ? 'fatal' : 'warning';
}

export function diagnostic(code: DiagnosticCode, subject: Diagnostic['subject']): Diagnostic {
  return { code, severity: severityOf(code), subject };
}

export const onOrder = (code: DiagnosticCode): Diagnostic => diagnostic(code, { kind: 'order' });

/** Stable order, so a diagnostics array is comparable between runs and in a fixture. */
export function sortDiagnostics(diagnostics: readonly Diagnostic[]): readonly Diagnostic[] {
  const subjectKey = (d: Diagnostic): string => {
    switch (d.subject.kind) {
      case 'order':
        return '';
      case 'line':
        return d.subject.orderItemId;
      case 'shipment':
        return d.subject.shipmentId;
      case 'payment':
        return String(d.subject.index).padStart(4, '0');
      case 'reversal':
        return d.subject.reversalId;
    }
  };
  return [...diagnostics].sort((a, b) => {
    if (a.subject.kind !== b.subject.kind) return a.subject.kind < b.subject.kind ? -1 : 1;
    const ka = subjectKey(a);
    const kb = subjectKey(b);
    if (ka !== kb) return ka < kb ? -1 : 1;
    return a.code < b.code ? -1 : a.code > b.code ? 1 : 0;
  });
}
