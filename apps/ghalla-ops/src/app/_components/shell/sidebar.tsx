'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Search } from 'lucide-react';
import { NAV_GROUPS, NAV_ITEMS, isActive } from '../../../lib/ui/nav';
import type { NavItem } from '../../../lib/ui/nav';
import { count } from '../../../lib/ui/format';
import { cn } from '../../../lib/ui/cn';
import { Brand } from './brand';
import { NavGlyph } from './nav-icon';

/**
 * The rail: brand, three groups of links, a jump-to-store card and the
 * operator's own timezone.
 *
 * A client component only because active state depends on the current path.
 * The counts are props from the server layout — a nav badge is a number the
 * database knows, and re-deriving it here would be the second definition the
 * query layer exists to prevent.
 */

export interface SidebarCounts {
  readonly stores: number;
  readonly alerts: number;
  readonly queue: number;
}

/**
 * Which trailing number each item carries.
 *
 * The badge is RED and solid, and only Health gets one, because it is the only
 * item that means "go here now". Making the store count look the same way would
 * teach the operator to ignore red in the one place it matters.
 */
function trailing(item: NavItem, counts: SidebarCounts): { kind: 'count' | 'badge'; value: number } | null {
  if (item.href === '/stores') return { kind: 'count', value: counts.stores };
  if (item.href === '/health') {
    return counts.alerts > 0 ? { kind: 'badge', value: counts.alerts } : null;
  }
  if (item.href.startsWith('/queues')) return { kind: 'count', value: counts.queue };
  return null;
}

export function Sidebar({
  counts,
  onJump,
}: {
  readonly counts: SidebarCounts;
  readonly onJump: () => void;
}) {
  const pathname = usePathname();

  return (
    <nav
      aria-label="Console"
      className="flex w-sidebar shrink-0 flex-col border-r border-shell bg-rail px-[14px] py-[18px]"
    >
      <div className="border-b border-shell px-1 pb-4">
        <Brand />
      </div>

      <div className="flex flex-col gap-[2px] pt-[10px]">
        {NAV_GROUPS.map((group) => (
          <div key={group} className="contents">
            <div className="px-[10px] pt-[11px] pb-[5px] text-kicker font-extrabold tracking-kicker uppercase text-muted">
              {group}
            </div>
            {NAV_ITEMS.filter((item) => item.group === group).map((item) => {
              const active = isActive(item.href, pathname);
              const badge = trailing(item, counts);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'flex items-center gap-[9px] rounded-pill-lg px-[10px] py-[9px] text-title transition-colors',
                    active
                      ? 'bg-primary-tint font-bold text-primary-deep'
                      : 'font-medium text-muted hover:bg-shell hover:text-ink',
                  )}
                >
                  <NavGlyph icon={item.icon} />
                  <span className="relative">{item.label}</span>
                  {badge === null ? null : badge.kind === 'badge' ? (
                    <span className="relative ml-auto inline-flex h-[17px] min-w-[18px] items-center justify-center rounded-pill bg-bad-badge px-[5px] text-chip font-extrabold text-white">
                      {count(badge.value)}
                    </span>
                  ) : (
                    <span className="relative ml-auto text-meta text-muted">{count(badge.value)}</span>
                  )}
                </Link>
              );
            })}
          </div>
        ))}
      </div>

      <div className="mt-auto flex flex-col gap-[10px]">
        {/* Opens the jump dialog. A button and nothing else: no key is bound to
            it, by decision — the card is always on screen, one click away. */}
        <button
          type="button"
          onClick={onJump}
          className="cursor-pointer rounded-card border border-shell bg-shell px-[11px] py-[10px] text-left transition-colors hover:border-ink"
        >
          <span className="flex items-center gap-[7px] text-cell font-semibold text-muted">
            <Search size={13} strokeWidth={2} aria-hidden className="text-faint" />
            Jump to store
          </span>
        </button>

        <div className="flex items-center gap-2 border-t border-shell pt-[11px]">
          <div className="flex size-[26px] items-center justify-center rounded-[8px] bg-shell text-meta font-extrabold text-ink">
            AK
          </div>
          <div className="leading-[1.25]">
            <div className="text-cell font-bold">Operator</div>
            {/* The operator's own zone, stated once. Everything on screen is in
                it unless a store's row says otherwise. */}
            <div className="text-chip text-muted">Amman · UTC+3</div>
          </div>
        </div>
      </div>
    </nav>
  );
}
