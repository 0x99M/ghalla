import { Activity, ChartColumn, House, List, Smartphone, Store } from 'lucide-react';
import type { NavIcon } from '../../../lib/ui/nav';

const ICONS = {
  overview: House,
  stores: Store,
  health: Activity,
  revenue: ChartColumn,
  queues: List,
  narrow: Smartphone,
} as const satisfies Record<NavIcon, unknown>;

/** 15px at stroke 2, per the handoff. Decorative: the label beside it is the name. */
export function NavGlyph({ icon }: { readonly icon: NavIcon }) {
  const Glyph = ICONS[icon];
  return <Glyph size={15} strokeWidth={2} aria-hidden className="relative shrink-0" />;
}
