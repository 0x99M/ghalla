import { IBM_Plex_Mono, Montserrat } from 'next/font/google';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata = {
  title: 'Ghalla Ops',
  description: 'Internal operator portal',
};

/**
 * Self-hosted, subset and preloaded at build time.
 *
 * The handoff loads these from the Google Fonts CDN. That is wrong for this
 * console twice over: it puts a render-blocking third-party request in front of
 * the screen somebody opens during an incident, and a font that fails to arrive
 * silently re-measures every column in a layout whose whole argument is that
 * figures line up. `next/font` also pins the exact weights, so a weight nobody
 * asked for cannot creep into a component.
 */
const montserrat = Montserrat({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700', '800'],
  variable: '--font-montserrat',
  display: 'swap',
});

const plexMono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-plex-mono',
  display: 'swap',
});

/**
 * Deliberately NOT the console shell.
 *
 * `/login` renders through this layout too, and it must not show a sidebar full
 * of links that answer 401 — the shell lives in the `(console)` route group so
 * the one unauthenticated screen stays a form on a page.
 */
export default function RootLayout({ children }: { readonly children: ReactNode }) {
  return (
    <html lang="en" className={`${montserrat.variable} ${plexMono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
