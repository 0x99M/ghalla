import type { ReactNode } from 'react';
import { getConsoleSummary } from '../../lib/data';
import { ConsoleChrome } from '../_components/shell/console-chrome';

export const dynamic = 'force-dynamic';

/**
 * The console shell: rail on the left, topbar above, screen below.
 *
 * A Server Component, so the sidebar's counts are read once per page load
 * rather than fetched from the client after paint. Everything that needs the
 * current path or keyboard state lives inside `ConsoleChrome`, which is the
 * client boundary — drawn here rather than around the whole layout so the page
 * inside stays a Server Component and keeps reading `lib/data` directly.
 *
 * `/login` deliberately does not render through this: it is outside the route
 * group, because a sign-in screen showing a sidebar of links that all answer
 * 401 is a worse first impression than a form on a page.
 */
export default async function ConsoleLayout({ children }: { readonly children: ReactNode }) {
  const summary = await getConsoleSummary();

  return (
    <ConsoleChrome counts={{ stores: summary.stores, alerts: summary.alerts, queue: summary.queue }}>
      {children}
    </ConsoleChrome>
  );
}
