'use client';

import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { usePathname } from 'next/navigation';

/**
 * How a screen tells the topbar what it is looking at.
 *
 * The topbar lives in the layout and the numbers live in the page, so something
 * has to cross that boundary. This is the smallest thing that can: a page
 * renders `<PageMeta />` with the `capturedAt` its own report carried, and the
 * topbar shows it.
 *
 * `capturedAt` MUST come from the report rather than from the moment the topbar
 * rendered. They differ by however long the query took plus up to a minute of
 * cache, and the entire purpose of a console that never auto-refreshes is that
 * the operator can see which of the two they are looking at.
 */

export interface ScreenState {
  /** From the report's own `capturedAt`. `null` before a page has said. */
  readonly capturedAt: string | null;
  /** Overrides the route-derived title. Only the store detail page needs it. */
  readonly title: string | null;
  /** Whether the report on screen is missing a platform. */
  readonly partial: boolean;
}

const EMPTY: ScreenState = { capturedAt: null, title: null, partial: false };

interface ScreenContextValue {
  readonly state: ScreenState;
  readonly setState: (next: ScreenState) => void;
}

const ScreenContext = createContext<ScreenContextValue>({ state: EMPTY, setState: () => undefined });

export function useScreenState(): ScreenState {
  return useContext(ScreenContext).state;
}

export function ScreenStateProvider({ children }: { readonly children: ReactNode }) {
  const [state, setState] = useState<ScreenState>(EMPTY);
  const pathname = usePathname();

  // Cleared on navigation, so a screen that has not reported yet shows no
  // stamp rather than the PREVIOUS screen's. A stale "updated 2m ago" carried
  // across a navigation is the exact false reassurance this console exists to
  // avoid.
  useEffect(() => {
    setState(EMPTY);
  }, [pathname]);

  const value = useMemo(() => ({ state, setState }), [state]);
  return <ScreenContext.Provider value={value}>{children}</ScreenContext.Provider>;
}

/**
 * Rendered by every console screen. Sets, never reads.
 *
 * A component rather than a prop drilled through the layout because in the App
 * Router a layout cannot see its child page's data — the page renders inside a
 * slot the layout has already returned.
 */
export function PageMeta({
  capturedAt,
  title = null,
  partial = false,
}: {
  readonly capturedAt: string;
  readonly title?: string | null;
  readonly partial?: boolean;
}) {
  const { setState } = useContext(ScreenContext);

  useEffect(() => {
    setState({ capturedAt, title, partial });
  }, [capturedAt, title, partial, setState]);

  return null;
}
