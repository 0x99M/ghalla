import { describe, expect, it } from 'vitest';
import { toInstant } from '@ghalla/contracts';
import { consoleSummary, emptyConsoleSummary, oldestCapture } from '../src/lib/queries/console-summary';
import type { AlertFeed } from '../src/lib/queries/alert-feed';
import type { Overview } from '../src/lib/queries/overview';
import type { PaymentQueue } from '../src/lib/queries/payment-queue';

const at = (iso: string) => toInstant(iso);

function overviewWith(stores: number, capturedAt: string, partial = false): Overview {
  return {
    totals: {
      stores,
      active: 0,
      trialing: 0,
      pastDue: 0,
      listMrrMinor: 0 as Overview['totals']['listMrrMinor'],
      listArrMinor: 0 as Overview['totals']['listArrMinor'],
      unknownPlanSubscriptions: 0,
      ordersIngested24h: 0,
      queueDepth: 0,
      stalledJobs: 0,
      webhookSuccessBps: null,
      coverageBps: null,
    },
    platforms: [],
    missing: [],
    partial,
    capturedAt: at(capturedAt),
  };
}

function feedWith(acknowledged: readonly (string | null)[], capturedAt: string, partial = false): AlertFeed {
  return {
    alerts: acknowledged.map((ack, index) => ({
      key: `silent_store:salla:${String(index)}`,
      kind: 'silent_store' as const,
      platform: 'salla' as AlertFeed['alerts'][number]['platform'],
      storeId: `salla:${String(index)}`,
      detail: 'no webhook has ever arrived from this store',
      acknowledgedUntil: ack === null ? null : at(ack),
    })),
    unavailable: {},
    acksUnavailable: null,
    partial,
    capturedAt: at(capturedAt),
  };
}

function queueWith(rows: number, capturedAt: string, partial = false): PaymentQueue {
  return {
    rows: Array.from({ length: rows }, (_, index) => ({
      platform: 'salla' as PaymentQueue['rows'][number]['platform'],
      storeId: `salla:${String(index)}`,
      instrument: 'unknown',
      rawMethodLabel: `label-${String(index)}`,
      orders: 1,
    })),
    missing: [],
    partial,
    capturedAt: at(capturedAt),
  };
}

describe('oldestCapture', () => {
  it('returns the earliest, because that is the age of the whole screen', () => {
    expect(
      oldestCapture([
        at('2026-09-05T14:24:00.000Z'),
        at('2026-09-05T14:20:00.000Z'),
        at('2026-09-05T14:23:00.000Z'),
      ]),
    ).toBe('2026-09-05T14:20:00.000Z');
  });
});

describe('consoleSummary', () => {
  it('counts only UNACKNOWLEDGED alerts', () => {
    // An alert somebody has already handled is not a summons, and a badge that
    // keeps counting it teaches the operator to ignore the badge.
    const summary = consoleSummary(
      overviewWith(312, '2026-09-05T14:24:00.000Z'),
      feedWith([null, '2026-09-06T00:00:00.000Z', null], '2026-09-05T14:24:00.000Z'),
      queueWith(10, '2026-09-05T14:24:00.000Z'),
    );
    expect(summary).toStrictEqual({
      stores: 312,
      alerts: 2,
      queue: 10,
      partial: false,
      capturedAt: '2026-09-05T14:24:00.000Z',
    });
  });

  it('takes the oldest of the three captures', () => {
    const summary = consoleSummary(
      overviewWith(1, '2026-09-05T14:24:00.000Z'),
      feedWith([], '2026-09-05T14:19:00.000Z'),
      queueWith(0, '2026-09-05T14:22:00.000Z'),
    );
    expect(summary.capturedAt).toBe('2026-09-05T14:19:00.000Z');
  });

  it('is partial when ANY input was partial', () => {
    const base = ['2026-09-05T14:24:00.000Z', '2026-09-05T14:24:00.000Z', '2026-09-05T14:24:00.000Z'] as const;
    expect(consoleSummary(overviewWith(1, base[0], true), feedWith([], base[1]), queueWith(0, base[2])).partial).toBe(true);
    expect(consoleSummary(overviewWith(1, base[0]), feedWith([], base[1], true), queueWith(0, base[2])).partial).toBe(true);
    expect(consoleSummary(overviewWith(1, base[0]), feedWith([], base[1]), queueWith(0, base[2], true)).partial).toBe(true);
  });
});

describe('emptyConsoleSummary', () => {
  it('stamps the moment it was asked', () => {
    const now = new Date('2026-09-05T14:24:00.000Z');
    expect(emptyConsoleSummary(now)).toStrictEqual({
      stores: 0,
      alerts: 0,
      queue: 0,
      partial: false,
      capturedAt: '2026-09-05T14:24:00.000Z',
    });
  });
});
