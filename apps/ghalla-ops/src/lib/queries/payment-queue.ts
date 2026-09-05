import { toInstant } from '@ghalla/contracts';
import type { Instant, PlatformId } from '@ghalla/contracts';
import { queryPlatforms } from '../platforms/registry';
import type { PlatformRegistry } from '../platforms/registry';
import { unknownPaymentMethods } from './ingestion';

/**
 * The unmapped-payment-method queue, across platforms.
 *
 * This is a work list, not a metric. Every row is a rail an adapter could not
 * map, which means its gateway fee was priced by fallback — a margin shown to a
 * merchant that we cannot stand behind. Ranked by order count, because the
 * label on four hundred orders is worth a fee rule and the one on two is not.
 */

export interface QueueRow {
  readonly platform: PlatformId;
  readonly storeId: string;
  readonly instrument: string;
  readonly rawMethodLabel: string;
  readonly orders: number;
}

export interface PaymentQueue {
  readonly rows: readonly QueueRow[];
  readonly missing: readonly { readonly platform: PlatformId; readonly reason: string }[];
  readonly partial: boolean;
  readonly capturedAt: Instant;
}

/** Per platform, before the merge. High enough to see the tail, low enough to bound the read. */
export const QUEUE_LIMIT = 100;

export async function unknownPaymentMethodQueue(registry: PlatformRegistry): Promise<PaymentQueue> {
  const fan = await queryPlatforms(registry, async (handle) =>
    unknownPaymentMethods(handle.db, QUEUE_LIMIT),
  );

  const rows = fan.ok
    .flatMap((result) => result.value.map((row) => ({ ...row, platform: result.platform })))
    .sort((a, b) => b.orders - a.orders);

  return {
    rows,
    missing: fan.failed.map((failure) => ({ platform: failure.platform, reason: failure.reason })),
    partial: fan.partial,
    capturedAt: toInstant(fan.capturedAt),
  };
}
