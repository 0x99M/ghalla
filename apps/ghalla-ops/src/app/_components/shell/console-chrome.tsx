'use client';

import { useCallback, useState } from 'react';
import type { ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { Sidebar } from './sidebar';
import type { SidebarCounts } from './sidebar';
import { TopBar } from './topbar';
import { JumpDialog } from './jump-dialog';
import { ScreenStateProvider } from './page-meta';

/**
 * The client half of the shell.
 *
 * Owns the one piece of shell state that is not in the URL: whether the
 * "Jump to store" dialog is open. It is opened from the sidebar card and from
 * nowhere else — no key is bound to it, by decision. The handoff's ⌘K was a
 * shortcut to a card that is always on screen, and in Firefox the same chord
 * is focus-the-search-bar; a control with one obvious way in is easier to
 * trust than one with two.
 *
 * Navigation on pick is a `router.push` to the store's own URL, so the jump is
 * an ordinary page load of the same detail screen a table row links to.
 */
export function ConsoleChrome({
  counts,
  children,
}: {
  readonly counts: SidebarCounts;
  readonly children: ReactNode;
}) {
  const router = useRouter();
  const [jumpOpen, setJumpOpen] = useState(false);

  const openJump = useCallback(() => {
    setJumpOpen(true);
  }, []);

  const pick = useCallback(
    (href: string) => {
      setJumpOpen(false);
      router.push(href);
    },
    [router],
  );

  return (
    <ScreenStateProvider>
      <div className="flex min-h-screen bg-ground text-ink">
        <Sidebar counts={counts} onJump={openJump} />
        <div className="flex min-w-0 flex-1 flex-col">
          <TopBar />
          <main className="flex flex-col gap-[14px] px-5 pt-4 pb-[26px]">{children}</main>
        </div>
      </div>
      <JumpDialog open={jumpOpen} onOpenChange={setJumpOpen} onPick={pick} />
    </ScreenStateProvider>
  );
}
