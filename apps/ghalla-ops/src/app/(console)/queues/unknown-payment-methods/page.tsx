import { getPaymentQueue } from '../../../../lib/data';
import { PageMeta } from '../../../_components/shell/page-meta';
import { CampaignQueue, PaymentMethodQueue } from '../../../_components/queues/queue';
import { SectionError } from '../../../_components/ui/states';

export const dynamic = 'force-dynamic';

/**
 * Mapping decisions that keep the numbers correct.
 *
 * Finishable by design: the list shrinks as rails get fee rules, and an empty
 * list is a real, reachable state rather than a placeholder.
 */
export default async function QueuesPage() {
  const queue = await getPaymentQueue();

  return (
    <>
      <PageMeta capturedAt={queue.capturedAt} partial={queue.partial} />

      {queue.partial ? (
        <SectionError
          title="Some platforms could not be read"
          error={queue.missing.map((entry) => `${entry.platform}: ${entry.reason}`).join(' · ')}
          at={queue.capturedAt}
        />
      ) : null}

      <PaymentMethodQueue queue={queue} />
      <CampaignQueue />
    </>
  );
}
