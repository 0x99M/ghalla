import { OPERATOR_TIME_ZONE, stamp } from '../../../lib/ui/format';
import { cn } from '../../../lib/ui/cn';

/**
 * A relative time with the absolute one, zone and all, behind it.
 *
 * The zone is never optional. The operator sits in Asia/Amman and the stores
 * sit in Gulf zones an hour ahead; an unlabelled `14:20` is ambiguous by
 * exactly the amount that makes an incident timeline wrong. `zone` names which
 * clock this instant is being SHOWN in — passing a store's own zone is how the
 * store detail header shows both.
 */
export function TimeStamp({
  at,
  now,
  zone = OPERATOR_TIME_ZONE,
  suffix,
  className,
}: {
  readonly at: string | null;
  readonly now: Date;
  readonly zone?: string;
  readonly suffix?: string;
  readonly className?: string;
}) {
  const { relative, absolute } = stamp(at, now, zone);
  return (
    <time
      dateTime={at ?? undefined}
      title={absolute}
      className={cn('cursor-help underline decoration-dotted decoration-from-font underline-offset-2', className)}
    >
      {relative}
      {suffix === undefined || at === null ? null : ` ${suffix}`}
    </time>
  );
}
