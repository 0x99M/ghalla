import { notFound } from 'next/navigation';
import { getStoreDetail } from '../../../../../lib/data';
import { loadPlatformConfigs } from '../../../../../lib/platforms/config';
import { PageMeta } from '../../../../_components/shell/page-meta';
import {
  DataQualityCard,
  FailuresCard,
  IngestionCard,
  StoreHeader,
  SubscriptionCard,
} from '../../../../_components/store/sections';
import { OperatorActions } from '../../../../_components/store/actions';
import type { ActionDescriptor } from '../../../../_components/store/actions';
import { SectionError } from '../../../../_components/ui/states';

export const dynamic = 'force-dynamic';

/**
 * One merchant, in full — the screen somebody opens because they think this
 * store is broken.
 *
 * Not cached anywhere in the stack, deliberately. Everything else on this
 * console is a rollup that can be a minute stale without misleading anybody;
 * this is the page an operator loads right after doing something about a store,
 * and a cached answer shows the state before the fix and invites a second one.
 */
export default async function StoreDetailPage({
  params,
}: {
  readonly params: Promise<{ readonly platform: string; readonly storeId: string }>;
}) {
  const { platform, storeId } = await params;
  const decoded = decodeURIComponent(storeId);
  const result = await getStoreDetail(platform, decoded);
  const now = new Date();

  if (result.kind === 'unknown_platform' || result.kind === 'not_found') notFound();

  if (result.kind === 'unavailable') {
    // NOT a 404. "No such store" and "this platform's database is refusing
    // connections" are different answers, and only one of them means somebody
    // mistyped a URL.
    return (
      <SectionError
        title={`${platform} could not be read`}
        error={result.reason}
        at={now.toISOString()}
      />
    );
  }

  const { detail } = result;
  const adminApi = adminApiFor(platform);

  const actions: readonly ActionDescriptor[] = [
    {
      id: 'recompute',
      label: 'Recompute profit',
      description: 'Re-runs the profit engine over every order in this store, at the current calc version.',
      target: `POST ${adminApi ?? '<admin api>'}/admin/recompute · store=${detail.store.storeId}`,
    },
    {
      id: 'backfill',
      label: 'Re-run backfill',
      description: 'Restarts the orders backfill from the beginning. Backfilled orders are never metered.',
      target: `POST ${adminApi ?? '<admin api>'}/admin/backfill · store=${detail.store.storeId} · resource=orders`,
    },
    {
      id: 'replay',
      label: 'Replay failed events',
      description: 'Moves this store’s dead-lettered webhook events back to pending.',
      target: `POST ${adminApi ?? '<admin api>'}/admin/webhooks/replay · store=${detail.store.storeId}`,
    },
    {
      id: 'reconcile',
      label: 'Force reconciliation',
      description: 'Asks the platform for this store’s current subscription and applies the answer.',
      target: `POST ${adminApi ?? '<admin api>'}/admin/billing/reconcile · store=${detail.store.storeId}`,
    },
  ];

  return (
    <>
      <PageMeta capturedAt={detail.capturedAt} title={detail.store.platformStoreId} />

      <StoreHeader detail={detail} now={now} />

      <div className="grid grid-cols-2 gap-3">
        <SubscriptionCard detail={detail} now={now} />
        <IngestionCard detail={detail} now={now} />
        <DataQualityCard detail={detail} />
        <FailuresCard failures={detail.recentFailures} now={now} />
      </div>

      <OperatorActions
        actions={actions}
        available={false}
        unavailableReason={
          adminApi === null
            ? `No admin API is configured for ${platform}. Set ADMIN_API_URL_${platform.toUpperCase()} and ADMIN_API_TOKEN_${platform.toUpperCase()}.`
            : 'Action dispatch is not built yet — the integration exposes no admin endpoints. Nothing here can write.'
        }
      />
    </>
  );
}

/**
 * The admin API base URL for a platform, or `null`.
 *
 * Read server-side and only the URL crosses to the client. The TOKEN never
 * leaves this process — an integration admin token in a client bundle is the
 * brief's first prohibition, and the shape of this function is what enforces it.
 */
function adminApiFor(platform: string): string | null {
  try {
    const config = loadPlatformConfigs(process.env).find((entry) => entry.platform === platform);
    return config?.adminApi?.baseUrl ?? null;
  } catch {
    return null;
  }
}
