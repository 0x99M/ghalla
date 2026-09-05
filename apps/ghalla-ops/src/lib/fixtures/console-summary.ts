import { consoleSummary } from '../queries/console-summary';
import type { ConsoleSummary } from '../queries/console-summary';
import { alertFeedFixture, overviewFixture, paymentQueueFixture } from './reports';

/**
 * The sidebar's counts, folded from the very reports the screens render.
 *
 * Not typed out. A hand-written `alerts: 3` beside a feed that produces four
 * rows is the exact failure the fold exists to prevent, and it is the kind that
 * survives review because both numbers look reasonable on their own.
 */
export const consoleSummaryFixture: ConsoleSummary = consoleSummary(
  overviewFixture(),
  alertFeedFixture(),
  paymentQueueFixture(),
);
