'use client';

import { useCallback, useEffect } from 'react';
import type { ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { Sidebar } from './sidebar';
import type { SidebarCounts } from './sidebar';
import { TopBar } from './topbar';
import { ScreenStateProvider } from './page-meta';

/**
 * The client half of the shell, and the only place the console binds a key.
 *
 * ⌘K and Ctrl+K are bound here rather than inside the palette, because a
 * listener that only exists while the palette is mounted cannot be the thing
 * that mounts it.
 *
 * INTERIM: the key and the sidebar's "Jump to store" card both navigate to the
 * store list instead of opening the palette. The palette searches stores by
 * NAME, and no name exists anywhere in the schema — see the handoff notes. It
 * lands with the Stores screen once that is resolved; sending the operator to
 * the list they were trying to search is the closest true behaviour in the
 * meantime, and it is better than a control that opens nothing.
 *
 * `preventDefault` on ⌘K is deliberate: in Firefox it is focus-the-search-bar,
 * and an operator who half-remembers which app they are in should get the same
 * behaviour either way rather than being thrown into the browser chrome.
 */
export function ConsoleChrome({
  counts,
  children,
}: {
  readonly counts: SidebarCounts;
  readonly children: ReactNode;
}) {
  const router = useRouter();

  const jumpToStore = useCallback(() => {
    router.push('/stores');
  }, [router]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        router.push('/stores');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [router]);

  return (
    <ScreenStateProvider>
      <div className="flex min-h-screen bg-ground text-ink">
        <Sidebar counts={counts} onOpenPalette={jumpToStore} />
        <div className="flex min-w-0 flex-1 flex-col">
          <TopBar />
          <main className="flex flex-col gap-[14px] px-5 pt-4 pb-[26px]">{children}</main>
        </div>
      </div>
    </ScreenStateProvider>
  );
}
