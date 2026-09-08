/**
 * The console's navigation, as data.
 *
 * Here rather than inside the sidebar component for one reason: which item is
 * active is a real decision with a real edge — `/stores` must stay lit while an
 * operator is three levels down inside `/stores/salla/abc` — and a decision
 * that can be wrong belongs where a table test can reach it. The component
 * renders what this returns and decides nothing.
 *
 * Icons are named rather than imported so this module stays free of React and
 * can be tested as a plain function.
 */

export const NAV_GROUPS = ['Monitor', 'Business', 'Views'] as const;
export type NavGroup = (typeof NAV_GROUPS)[number];

export type NavIcon = 'overview' | 'stores' | 'health' | 'revenue' | 'queues' | 'narrow';

/** How the trailing number on a nav item should read. */
export type NavCount =
  /** A plain count, muted. */
  | { readonly kind: 'count'; readonly value: number }
  /** A solid red badge. Reserved for things that need attention NOW. */
  | { readonly kind: 'badge'; readonly value: number }
  | { readonly kind: 'none' };

export interface NavItem {
  readonly href: string;
  readonly label: string;
  readonly icon: NavIcon;
  readonly group: NavGroup;
}

export const NAV_ITEMS: readonly NavItem[] = [
  { href: '/', label: 'Overview', icon: 'overview', group: 'Monitor' },
  { href: '/stores', label: 'Stores', icon: 'stores', group: 'Monitor' },
  { href: '/health', label: 'Health', icon: 'health', group: 'Monitor' },
  { href: '/revenue', label: 'Revenue', icon: 'revenue', group: 'Business' },
  { href: '/queues/unknown-payment-methods', label: 'Review queues', icon: 'queues', group: 'Business' },
  { href: '/narrow', label: 'Narrow overview', icon: 'narrow', group: 'Views' },
];

/**
 * Whether a nav item owns the current path.
 *
 * `/` is exact and everything else matches its subtree, which is the only
 * arrangement that lights Stores on a store detail page without lighting
 * Overview on every page in the console.
 */
export function isActive(href: string, pathname: string): boolean {
  if (href === '/') return pathname === '/';
  return pathname === href || pathname.startsWith(`${href}/`);
}

export interface ScreenMeta {
  readonly title: string;
  readonly subtitle: string;
}

/**
 * The topbar's title and one-line subtitle, from the route.
 *
 * A store detail page overrides the title with the merchant's name through
 * `PageMeta`, because the route only knows an id. Everything else is static,
 * and static is right: these are the same words every time, and generating them
 * from data would make them drift.
 */
const SCREENS: readonly (readonly [string, ScreenMeta])[] = [
  [
    '/stores',
    {
      title: 'Stores',
      subtitle: 'Every merchant, sortable and filterable · click a row for the full record',
    },
  ],
  [
    '/health',
    {
      title: 'Health',
      subtitle: 'Queues, failures and the webhook path · opened when something is wrong',
    },
  ],
  [
    '/revenue',
    {
      title: 'Revenue',
      subtitle: 'MRR, plan and platform mix, conversion, churn and cohort retention · SAR',
    },
  ],
  [
    '/queues',
    {
      title: 'Review queues',
      subtitle: 'Mapping decisions that keep the numbers correct · finishable by design',
    },
  ],
  [
    '/narrow',
    { title: 'Narrow overview', subtitle: 'The phone check · read-only, overview only' },
  ],
];

export const OVERVIEW_SCREEN: ScreenMeta = {
  title: 'Overview',
  subtitle: 'Morning check · all times Asia/Amman unless marked',
};

export function screenMeta(pathname: string): ScreenMeta {
  if (pathname === '/') return OVERVIEW_SCREEN;
  for (const [prefix, meta] of SCREENS) {
    if (isActive(prefix, pathname)) return meta;
  }
  return OVERVIEW_SCREEN;
}

/**
 * The store detail URL, built in one place.
 *
 * Four components linked to a store and three of them built the path inline.
 * `storeId` is percent-encoded because it is platform-issued and may carry a
 * colon or a slash; `platform` is a slug from `GHALLA_PLATFORMS` and is not.
 */
export function storeHref(platform: string, storeId: string): string {
  return `/stores/${platform}/${encodeURIComponent(storeId)}`;
}
