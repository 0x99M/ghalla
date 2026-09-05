import { getRegistry } from '../../../../lib/platforms';
import { unknownPaymentMethodQueue } from '../../../../lib/queries/payment-queue';
import { ok } from '../../../../lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  return ok(await unknownPaymentMethodQueue(getRegistry()));
}
