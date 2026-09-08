import Link from 'next/link';
import { cn } from '../../../lib/ui/cn';
import { storeHref } from '../../../lib/ui/nav';

/**
 * How a store is named on screen.
 *
 * The handoff shows a merchant NAME with its domain beneath. Neither exists:
 * `CanonicalStore` carries `platformStoreId`, `platform`, `currency`,
 * `timezone` and the VAT fields, and nothing else. Rather than invent a name,
 * this renders the identifier we do have in the slot the design gives the name,
 * with the platform beneath — so the layout, alignment and density are exactly
 * as designed and the gap is visible instead of papered over.
 *
 * One component, so filling that gap later is one edit rather than a search
 * across six screens.
 */
export function StoreRef({
  platform,
  platformStoreId,
  storeId,
  className,
  link = true,
}: {
  readonly platform: string;
  readonly platformStoreId: string;
  readonly storeId: string;
  readonly className?: string;
  readonly link?: boolean;
}) {
  const body = (
    <>
      <span className="block font-mono text-cell-lg font-medium">{platformStoreId}</span>
      <span className="block text-meta text-muted">{platform}</span>
    </>
  );

  if (!link) return <span className={cn('block min-w-0', className)}>{body}</span>;

  return (
    <Link
      href={storeHref(platform, storeId)}
      className={cn('block min-w-0 hover:underline', className)}
    >
      {body}
    </Link>
  );
}
